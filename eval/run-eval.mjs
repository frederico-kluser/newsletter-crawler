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
import { callJSON, relevanceZ, compileQuerySpec } from '../src/llm.js';
import { MODELS, DB_PATH } from '../src/config.js';
import { PROMPTS, PROMPT_IDS, BATCH_PROMPTS, BATCH_PROMPT_IDS } from './prompts.mjs';
import { scoreCell, missSummary, REL_BROAD, REL_STRICT } from './score.mjs';

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
// Modo LOTE (busca soft real: N itens/chamada). `--batch` liga; `--batch-size` (40) e
// `--batch-variants` (vb_current,vb_spec) escolhem. Mede precisão ESTRITA (direct) + AMPLA
// (direct∪similar) + latência por lote. O spec (vb_spec) é 1 chamada Pro por cenário (searchSpec).
const BATCH = args.batch === true || args.batch === 'true';
const BATCH_SIZE = Number(args['batch-size'] || 40);
const BATCH_VARIANT_IDS = String(args['batch-variants'] || BATCH_PROMPT_IDS.join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);
const batchVariants = BATCH_PROMPTS.filter((p) => BATCH_VARIANT_IDS.includes(p.id));

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden.json'), 'utf8'));
let pool = golden.pool.slice();
if (Number.isFinite(POOL_LIMIT)) pool = pool.slice(0, POOL_LIMIT);
const kindTool = new Set(golden.kindTool);
const variants = PROMPTS.filter((p) => VARIANT_IDS.includes(p.id));

// artigos do pool (título+conteúdo) do DB.
const db = new Database(DB_PATH, { readonly: true });
const getArt = db.prepare('SELECT id, title, content, summary_pt, blurb FROM articles WHERE id = ?');
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
// (scoreCell/missSummary/REL_* agora vêm de ./score.mjs — reusados pelo modo unário e o de lote)

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

// ---------------- modo LOTE ----------------
// Item de lote = produção (`toBatchItem` de search.js): título≤200 + summary≤400 (summary_pt|blurb|cabeça).
const toBatchItem = (art) => ({
  id: art.id,
  title: String(art.title || '').slice(0, 200),
  summary: String(art.summary_pt || art.blurb || art.content || '').replace(/\s+/g, ' ').trim().slice(0, 400),
});
const hashStr = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return h >>> 0; };
// Embaralha determinístico por (round, cenário) p/ diluir position bias entre rodadas sem Math.random.
function seededShuffle(arr, seed) {
  const a = arr.slice();
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Julga UM cenário em lotes de BATCH_SIZE; devolve records por-artigo (mesmo shape do modo unário)
// + latência agregada. Fusão tolerante id→veredito (faltando→none); erro de lote → none + fail.
async function judgeBatchCell(variant, modelKey, scn, spec, order) {
  const records = [];
  let batchCalls = 0, totalBatchMs = 0;
  const items = order.map((id) => toBatchItem(ART.get(id)));
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    const { system, user } = variant.build({ query: scn.query, spec, items: chunk });
    const t0 = Date.now();
    let results = [], fail = false;
    try {
      const out = await callJSON({
        model: MODEL_SLUG[modelKey], reasoning: { effort: EFFORT }, schema: variant.schema,
        schemaName: 'relevance_batch', system, user, retries: 1, fallbackModel: null,
      });
      results = Array.isArray(out?.results) ? out.results : [];
    } catch (e) { fail = true; void e; }
    const ms = Date.now() - t0;
    batchCalls++; totalBatchMs += ms;
    const byId = new Map();
    for (const r of results) { const id = Number(r.id); if (!byId.has(id)) byId.set(id, r); }
    for (const it of chunk) {
      const v = byId.get(it.id);
      const pred = v ? relevanceZ.parse({ relation: v.relation, kind: v.kind }) : { relation: 'none', kind: 'news' };
      records.push({
        scn: scn.id, id: it.id,
        gtRel: gtRelation(scn, it.id), predRel: pred.relation,
        gtKind: kindTool.has(it.id) ? 'tool' : 'news', predKind: pred.kind,
        ms, fail,
      });
    }
  }
  return { records, batchCalls, totalBatchMs };
}

async function runBatchRound(round) {
  const limit = pLimit(CONC);
  // 1) spec por cenário (1 chamada Pro/searchSpec cada) — só se algum variant precisa.
  const needSpec = batchVariants.some((v) => v.needsSpec);
  const specByScn = new Map();
  if (needSpec) {
    await Promise.all(golden.scenarios.map((scn) => limit(async () => {
      try { specByScn.set(scn.id, await compileQuerySpec(scn.query)); }
      catch (e) { log(`spec ${scn.id} FALHOU: ${e.message}`); specByScn.set(scn.id, null); }
    })));
  }
  // 2) julgamentos em lote (variante × modelo × cenário).
  const bucket = new Map();
  const meta = new Map();
  const tasks = [];
  for (const variant of batchVariants) {
    for (const modelKey of MODEL_KEYS) {
      const key = `${variant.id}||${modelKey}`;
      bucket.set(key, []); meta.set(key, { batchCalls: 0, totalBatchMs: 0 });
      for (const scn of golden.scenarios) {
        const order = seededShuffle(POOL, round * 1000 + hashStr(scn.id));
        const spec = variant.needsSpec ? specByScn.get(scn.id) : null;
        tasks.push(limit(async () => {
          const { records, batchCalls, totalBatchMs } = await judgeBatchCell(variant, modelKey, scn, spec, order);
          bucket.get(key).push(...records);
          const mm = meta.get(key); mm.batchCalls += batchCalls; mm.totalBatchMs += totalBatchMs;
        }));
      }
    }
  }
  let done = 0; const total = tasks.length;
  const tick = setInterval(() => log(`round-batch ${round}: ${done}/${total} cenários`), 20000);
  await Promise.all(tasks.map((p) => p.then((r) => { done++; return r; })));
  clearInterval(tick);
  // 3) scoring: AMPLO (direct∪similar) + ESTRITO (direct).
  const cells = {};
  for (const [key, recs] of bucket) {
    const [variant, model] = key.split('||');
    const mm = meta.get(key);
    cells[key] = {
      variant, model,
      broad: scoreCell(recs, { isRel: REL_BROAD }),
      strict: scoreCell(recs, { isRel: REL_STRICT }),
      meanBatchMs: Math.round(mm.totalBatchMs / (mm.batchCalls || 1)),
      batchCalls: mm.batchCalls,
      misses: missSummary(recs, { isRel: REL_STRICT }),
    };
  }
  const out = { round, mode: 'batch', batchSize: BATCH_SIZE, effort: EFFORT, poolSize: POOL.length, scenarios: golden.scenarios.length, at: new Date().toISOString(), cells };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `round-batch-${round}.json`), JSON.stringify(out, null, 2));
  const rows = Object.values(cells)
    .sort((a, b) => b.strict.macroF1 - a.strict.macroF1)
    .map((c) => `  ${c.variant.padEnd(12)} ${c.model.padEnd(5)} ESTRITO F1=${c.strict.macroF1} P=${c.strict.macroPrecision} R=${c.strict.macroRecall} | AMPLO F1=${c.broad.macroF1} P=${c.broad.macroPrecision} | ${c.meanBatchMs}ms/lote×${c.batchCalls} fails=${c.broad.jsonFails}`);
  log(`round-batch ${round} OK (size=${BATCH_SIZE}) →\n${rows.join('\n')}`);
  return out;
}

(async () => {
  if (BATCH) {
    log(`eval LOTE start: rounds ${START}..${START + ROUNDS - 1} | batch-variants=[${batchVariants.map((v) => v.id)}] models=[${MODEL_KEYS}] pool=${POOL.length} scn=${golden.scenarios.length} batchSize=${BATCH_SIZE} effort=${EFFORT} conc=${CONC}`);
    for (let i = 0; i < ROUNDS; i++) {
      const round = START + i;
      try { await runBatchRound(round); } catch (e) { log(`ERRO round-batch ${round}: ${e.message}`); }
    }
    log('eval LOTE DONE');
    return;
  }
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
