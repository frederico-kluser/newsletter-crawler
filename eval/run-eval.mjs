// Harness de avaliação do prompt de relevância (nosso judgeRelevance).
// Para cada (variante × modelo × cenário × artigo do pool) chama a LLM (SÓ DeepSeek V4 pro/flash,
// isolada: fallbackModel:null) e compara com o gabarito (eval/golden.json).
// Métrica primária: F1 macro de relevância binária (relevant = direct∪similar) por cenário.
// Também: acurácia 3-vias (direct/similar/none), acurácia de kind, latência média, falhas de JSON.
// Uso: node eval/run-eval.mjs [--rounds N] [--start R] [--pool-limit K] [--models flash,pro]
//      [--variants v0_baseline,v1_rubric] [--concurrency C] [--out-dir eval/results]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import pLimit from 'p-limit';
import { callJSON, relevanceZ } from '../src/llm.js';
import { MODELS, DB_PATH } from '../src/config.js';
import { PROMPTS, PROMPT_IDS } from './prompts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => {
    const [k, ...v] = s.trim().split(/\s+/);
    return [k, v.join(' ') || true];
  }),
);
const ROUNDS = Number(args.rounds || 1);
const START = Number(args.start || 1);
const POOL_LIMIT = args['pool-limit'] ? Number(args['pool-limit']) : Infinity;
const EFFORT = String(args.effort || 'high');
const CONC = Number(args.concurrency || 10);
const OUT_DIR = path.resolve(__dirname, '..', String(args['out-dir'] || 'eval/results'));
const MODEL_KEYS = String(args.models || 'flash,pro').split(',').map((s) => s.trim()).filter(Boolean);
const VARIANT_IDS = String(args.variants || PROMPT_IDS.join(',')).split(',').map((s) => s.trim());
const MODEL_SLUG = { flash: MODELS.flash, pro: MODELS.pro };

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden.json'), 'utf8'));
let pool = golden.pool.slice();
if (Number.isFinite(POOL_LIMIT)) pool = pool.slice(0, POOL_LIMIT);
const kindTool = new Set(golden.kindTool);
const variants = PROMPTS.filter((p) => VARIANT_IDS.includes(p.id));

// artigos do pool (título+conteúdo) do DB.
const db = new Database(DB_PATH, { readonly: true });
const getArt = db.prepare('SELECT id, title, content FROM articles WHERE id = ?');
const ART = new Map();
for (const id of pool) {
  const r = getArt.get(id);
  if (!r) { log(`AVISO: artigo ${id} não existe no DB — pulando`); continue; }
  ART.set(id, r);
}
const POOL = pool.filter((id) => ART.has(id));

// gabarito
function gtRelation(scn, id) {
  if (scn.direct.includes(id)) return 'direct';
  if (scn.similar.includes(id)) return 'similar';
  return 'none';
}
const isRel = (rel) => rel === 'direct' || rel === 'similar';

async function judge(variant, modelKey, scn, art) {
  const { system, user } = variant.build({ query: scn.query, title: art.title, content: art.content });
  const t0 = Date.now();
  try {
    const out = await callJSON({
      model: MODEL_SLUG[modelKey],
      reasoning: { effort: EFFORT },
      schema: variant.schema,
      schemaName: 'relevance',
      system,
      user,
      retries: 1,
      fallbackModel: null, // isola o modelo: SEM escalar flash->pro
    });
    const picked = variant.pick ? variant.pick(out) : out;
    const pred = relevanceZ.parse(picked);
    return { pred, ms: Date.now() - t0, fail: false };
  } catch (e) {
    return { pred: { relation: 'none', kind: 'news' }, ms: Date.now() - t0, fail: true, err: e.message };
  }
}

function scoreCell(records) {
  // records: [{scn, id, gtRel, predRel, gtKind, predKind, ms, fail}]
  const perScn = new Map();
  let latSum = 0, fails = 0, exact3 = 0, kindOk = 0, n = 0;
  for (const r of records) {
    n++; latSum += r.ms; if (r.fail) fails++;
    if (r.gtRel === r.predRel) exact3++;
    if (r.gtKind === r.predKind) kindOk++;
    if (!perScn.has(r.scn)) perScn.set(r.scn, { tp: 0, fp: 0, fn: 0, tn: 0 });
    const c = perScn.get(r.scn);
    const g = isRel(r.gtRel), p = isRel(r.predRel);
    if (g && p) c.tp++; else if (!g && p) c.fp++; else if (g && !p) c.fn++; else c.tn++;
  }
  const scn = {};
  let f1sum = 0, pSum = 0, rSum = 0, k = 0;
  for (const [name, c] of perScn) {
    const prec = c.tp + c.fp ? c.tp / (c.tp + c.fp) : 0;
    const rec = c.tp + c.fn ? c.tp / (c.tp + c.fn) : 0;
    const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
    scn[name] = { ...c, precision: +prec.toFixed(3), recall: +rec.toFixed(3), f1: +f1.toFixed(3) };
    f1sum += f1; pSum += prec; rSum += rec; k++;
  }
  return {
    n,
    macroF1: +(f1sum / k).toFixed(4),
    macroPrecision: +(pSum / k).toFixed(4),
    macroRecall: +(rSum / k).toFixed(4),
    acc3way: +(exact3 / n).toFixed(4),
    kindAcc: +(kindOk / n).toFixed(4),
    meanMs: Math.round(latSum / n),
    jsonFails: fails,
    perScenario: scn,
  };
}

async function runRound(round) {
  const limit = pLimit(CONC);
  const tasks = [];
  const bucket = new Map(); // key variant||model -> records[]
  for (const variant of variants) {
    for (const modelKey of MODEL_KEYS) {
      const key = `${variant.id}||${modelKey}`;
      bucket.set(key, []);
      for (const scn of golden.scenarios) {
        for (const id of POOL) {
          const art = ART.get(id);
          tasks.push(limit(async () => {
            const { pred, ms, fail } = await judge(variant, modelKey, scn, art);
            bucket.get(key).push({
              scn: scn.id, id,
              gtRel: gtRelation(scn, id), predRel: pred.relation,
              gtKind: kindTool.has(id) ? 'tool' : 'news', predKind: pred.kind,
              ms, fail,
            });
          }));
        }
      }
    }
  }
  let done = 0;
  const total = tasks.length;
  const tick = setInterval(() => log(`round ${round}: ${done}/${total} chamadas`), 20000);
  await Promise.all(tasks.map((p) => p.then((r) => { done++; return r; })));
  clearInterval(tick);

  const cells = {};
  for (const [key, recs] of bucket) {
    const [variant, model] = key.split('||');
    cells[key] = { variant, model, ...scoreCell(recs), misses: missSummary(recs) };
  }
  const out = { round, effort: EFFORT, poolSize: POOL.length, scenarios: golden.scenarios.length, at: new Date().toISOString(), cells };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `round-${round}.json`), JSON.stringify(out, null, 2));
  // resumo curto p/ log e monitor
  const rows = Object.values(cells)
    .sort((a, b) => b.macroF1 - a.macroF1)
    .map((c) => `  ${c.variant.padEnd(14)} ${c.model.padEnd(5)} F1=${c.macroF1} P=${c.macroPrecision} R=${c.macroRecall} acc3=${c.acc3way} kind=${c.kindAcc} ${c.meanMs}ms fails=${c.jsonFails}`);
  log(`round ${round} OK →\n${rows.join('\n')}`);
  return out;
}

function missSummary(recs) {
  const fp = [], fn = [];
  for (const r of recs) {
    const g = isRel(r.gtRel), p = isRel(r.predRel);
    if (!g && p) fp.push(`${r.scn}:${r.id}`);
    if (g && !p) fn.push(`${r.scn}:${r.id}`);
  }
  return { fp, fn };
}

(async () => {
  log(`eval start: rounds ${START}..${START + ROUNDS - 1} | variants=[${variants.map((v) => v.id)}] models=[${MODEL_KEYS}] pool=${POOL.length} scn=${golden.scenarios.length} effort=${EFFORT} conc=${CONC}`);
  for (let i = 0; i < ROUNDS; i++) {
    const round = START + i;
    try {
      await runRound(round);
    } catch (e) {
      log(`ERRO round ${round}: ${e.message}`);
    }
  }
  log('eval DONE');
})();
