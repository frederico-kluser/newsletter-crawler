// Loader do gabarito v3 da busca (eval/golden.v3.json), CHAVEADO POR URL.
// Por que URL e não id: o golden v2 (eval/golden.json) guardava ids auto-increment, e o restore/rebuild
// do banco reatribuiu todos — os ids continuaram "resolvendo", só que para artigos SEM relação, e o eval
// passou a pontuar lixo em silêncio. Aqui a URL é a chave estável; o id atual é resolvido na hora contra
// o SQLite (read-only) e o loader FALHA alto se mais de 10% do pool não resolver.
//
// Formato (version 3):
//   pool:      [{url, title, source, publishedAt, pickedFor}]  — pool GLOBAL (todas as URLs rotuladas)
//   kindTool:  [url]                                            — SOBRE ferramenta/lib/framework/produto
//   scenarios: [{id, lang, query, criteria, pool:[url], labels:{url: direct|similar|none}, notes:{url: txt}}]
//     scenario.pool   = foco do cenário (~12 candidatos, ⊆ pool global);
//     scenario.labels = matriz COMPLETA: rótulo de TODA URL do pool global (⊆ pool global, cobre o foco).
//
// Uso como lib:  const g = loadGolden();            // lê + valida + resolve (abre o DB read-only)
//                validateGolden(readGolden())       // só o schema, sem DB (teste offline)
//                toLegacyShape(g)                   // {pool:[ids], kindTool:[ids], scenarios:[{direct,similar}]}
// Uso como CLI:  node eval/golden.mjs [--file eval/golden.v3.json] [--db <crawler.db>] [--json]
//
// SQL fora do db.js DE PROPÓSITO (precedente: eval/run-eval.mjs): importar src/db.js abriria o banco
// em escrita e rodaria as migrações do schema — o eval só pode LER.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeUrl, foldText, log, warn, errorLog } from '../src/util.js';
import { resolveSourceDb } from './jev/lib/sample.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const GOLDEN_V3_PATH = path.join(__dirname, 'golden.v3.json');
export const RELATIONS = Object.freeze(['direct', 'similar', 'none']);
export const GOLDEN_VERSION = 3;
// Acima disso o gabarito não serve mais: melhor quebrar do que medir sobre um pool mutilado.
export const MAX_UNRESOLVED_FRAC = 0.1;
// Jaccard de tokens do título abaixo disso = a URL resolveu, mas o artigo parece OUTRO (aviso).
export const MIN_TITLE_SIM = 0.3;

// ---- leitura + schema (puro, sem DB) ----

export function readGolden(file = GOLDEN_V3_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const nonEmptyStr = (x) => typeof x === 'string' && x.trim().length > 0;

/**
 * Valida o schema v3 SEM tocar no banco. Nunca lança: devolve {ok, errors[]} para o chamador decidir
 * (o teste offline afirma errors vazio; o loadGolden lança com a lista).
 */
export function validateGolden(g) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!isObj(g)) return { ok: false, errors: ['golden não é um objeto JSON'] };
  if (g.version !== GOLDEN_VERSION) err(`version deve ser ${GOLDEN_VERSION} (veio ${g.version})`);
  if (!Array.isArray(g.pool) || !g.pool.length) err('pool global ausente ou vazio');
  if (!Array.isArray(g.scenarios) || !g.scenarios.length) err('scenarios ausente ou vazio');
  if (errors.length) return { ok: false, errors };

  const poolUrls = new Set();
  g.pool.forEach((p, i) => {
    if (!isObj(p) || !nonEmptyStr(p.url)) return err(`pool[${i}] sem url`);
    if (!nonEmptyStr(p.title)) err(`pool[${i}] sem title (${p.url})`);
    // A chave tem de ser a forma CANÔNICA: é ela que casa com articles.url (o crawler grava normalizado).
    if (normalizeUrl(p.url) !== p.url) err(`pool[${i}] url não normalizada: ${p.url}`);
    if (poolUrls.has(p.url)) err(`pool[${i}] url duplicada: ${p.url}`);
    poolUrls.add(p.url);
  });

  if (!Array.isArray(g.kindTool)) err('kindTool deve ser uma lista de URLs');
  else for (const u of g.kindTool) if (!poolUrls.has(u)) err(`kindTool fora do pool: ${u}`);

  const ids = new Set();
  g.scenarios.forEach((s, i) => {
    const tag = `scenarios[${i}]${s && s.id ? ` (${s.id})` : ''}`;
    if (!isObj(s)) return err(`${tag} não é objeto`);
    if (!nonEmptyStr(s.id)) err(`${tag} sem id`);
    else if (ids.has(s.id)) err(`${tag} id duplicado`);
    else ids.add(s.id);
    if (!nonEmptyStr(s.query)) err(`${tag} sem query`);
    if (s.lang !== 'pt' && s.lang !== 'en') err(`${tag} lang deve ser pt|en`);
    if (!Array.isArray(s.pool) || !s.pool.length) err(`${tag} sem pool (foco)`);
    if (!isObj(s.labels)) return err(`${tag} sem labels`);
    const labeled = Object.keys(s.labels);
    for (const u of labeled) {
      if (!poolUrls.has(u)) err(`${tag} label fora do pool global: ${u}`);
      if (!RELATIONS.includes(s.labels[u])) err(`${tag} relação inválida "${s.labels[u]}" em ${u}`);
    }
    // Matriz completa: cada cenário julga TODA URL do pool (é o que o harness roda).
    for (const u of poolUrls) if (!(u in s.labels)) err(`${tag} URL do pool sem rótulo: ${u}`);
    if (Array.isArray(s.pool)) {
      for (const u of s.pool) if (!poolUrls.has(u)) err(`${tag} foco fora do pool global: ${u}`);
      if (new Set(s.pool).size !== s.pool.length) err(`${tag} foco com URL repetida`);
    }
    const rels = new Set(labeled.map((u) => s.labels[u]));
    if (!rels.has('direct')) err(`${tag} sem nenhum direct (cenário não mede nada)`);
    if (!rels.has('none')) err(`${tag} sem nenhum none (não mede precisão)`);
    if (s.notes != null) {
      if (!isObj(s.notes)) err(`${tag} notes deve ser objeto {url: texto}`);
      else for (const u of Object.keys(s.notes)) if (!poolUrls.has(u)) err(`${tag} note fora do pool: ${u}`);
    }
  });
  return { ok: errors.length === 0, errors };
}

// ---- resolução URL -> id atual (precisa de um handle better-sqlite3) ----

/**
 * Banco de ORIGEM do gabarito = o MESMO de todo módulo do eval (resolveSourceDb do sample.mjs):
 * EVAL_SOURCE_DB, senão NC_HOME/crawler.db — sem importar o config (que carrega .env). O DB_PATH é
 * IGNORADO de propósito: o filho do eval roda sob ledgerEnv(), que aponta DB_PATH p/ o ledger
 * isolado (eval/jev/.ledger.db, sem artigos) — honrá-lo resolveria o golden contra o banco vazio.
 */
export function defaultDbPath(env = process.env) {
  return resolveSourceDb(env);
}

const titleTokens = (s) => new Set(foldText(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 3));

/** Jaccard de tokens (≥3 letras, sem acento) — só para AVISAR de artigo trocado, não decide nada. */
export function titleSimilarity(a, b) {
  const A = titleTokens(a);
  const B = titleTokens(b);
  if (!A.size || !B.size) return A.size === B.size ? 1 : 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// Chave de fallback: URL normalizada com o PATH em minúsculas (um agregador já gravou URL com o caminho
// em caixa diferente da canônica) — só entra quando o match exato falha.
function looseKey(u) {
  const n = normalizeUrl(u);
  if (!n) return null;
  try {
    const x = new URL(n);
    return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.toLowerCase()}${x.search}`;
  } catch {
    return n.toLowerCase();
  }
}

function makeResolver(db) {
  const exact = db.prepare('SELECT id, url, title FROM articles WHERE url = ?');
  let norm = null; // Map lazy: só varre a tabela se algum match exato falhar
  const buildNorm = () => {
    norm = new Map();
    for (const r of db.prepare('SELECT id, url, title FROM articles').iterate()) {
      const n = normalizeUrl(r.url);
      if (n && !norm.has(n)) norm.set(n, r);
      const l = looseKey(r.url);
      if (l && !norm.has(`~${l}`)) norm.set(`~${l}`, r);
    }
  };
  return (url) => {
    const hit = exact.get(url);
    if (hit) return { row: hit, via: 'exact' };
    if (!norm) buildNorm();
    const n = normalizeUrl(url);
    if (n && norm.has(n)) return { row: norm.get(n), via: 'normalized' };
    const l = looseKey(url);
    if (l && norm.has(`~${l}`)) return { row: norm.get(`~${l}`), via: 'loose' };
    return null;
  };
}

/**
 * Resolve o gabarito validado contra o banco. Lança se a fração não resolvida passar de
 * `maxUnresolvedFrac` (default 10%). Itens não resolvidos ficam FORA de pool/cenários resolvidos.
 */
export function resolveGolden(g, db, { maxUnresolvedFrac = MAX_UNRESOLVED_FRAC, minTitleSim = MIN_TITLE_SIM } = {}) {
  const resolve = makeResolver(db);
  const byUrl = new Map();
  const unresolved = [];
  const titleMismatch = [];
  const via = { exact: 0, normalized: 0, loose: 0 };
  for (const p of g.pool) {
    const hit = resolve(p.url);
    if (!hit) {
      unresolved.push(p.url);
      continue;
    }
    via[hit.via]++;
    const sim = titleSimilarity(p.title, hit.row.title);
    if (sim < minTitleSim) titleMismatch.push({ url: p.url, id: hit.row.id, golden: p.title, db: hit.row.title, sim: +sim.toFixed(2) });
    byUrl.set(p.url, { id: hit.row.id, dbTitle: hit.row.title, dbUrl: hit.row.url, titleSim: +sim.toFixed(2) });
  }
  const frac = g.pool.length ? unresolved.length / g.pool.length : 0;
  if (frac > maxUnresolvedFrac) {
    const e = new Error(
      `golden v3: ${unresolved.length}/${g.pool.length} URLs do pool não resolvem no banco (${(frac * 100).toFixed(1)}% > ` +
        `${(maxUnresolvedFrac * 100).toFixed(0)}%) — base errada/vazia? rode \`ncrawl restore\` ou re-rotule`,
    );
    e.code = 'GOLDEN_UNRESOLVED';
    e.unresolved = unresolved;
    throw e;
  }
  const idOf = (u) => byUrl.get(u)?.id;
  const pool = g.pool.filter((p) => byUrl.has(p.url)).map((p) => ({ ...p, id: idOf(p.url) }));
  const kindTool = new Set(g.kindTool.filter((u) => byUrl.has(u)).map(idOf));
  const scenarios = g.scenarios.map((s) => {
    const labels = new Map();
    for (const [u, rel] of Object.entries(s.labels)) if (byUrl.has(u)) labels.set(idOf(u), rel);
    const pick = (rel) => [...labels].filter(([, r]) => r === rel).map(([id]) => id);
    return {
      id: s.id,
      lang: s.lang,
      query: s.query,
      criteria: s.criteria ?? null,
      focus: s.pool.filter((u) => byUrl.has(u)).map(idOf),
      labels,
      direct: pick('direct'),
      similar: pick('similar'),
      notes: new Map(Object.entries(s.notes || {}).filter(([u]) => byUrl.has(u)).map(([u, t]) => [idOf(u), t])),
    };
  });
  return {
    version: g.version,
    pool,
    poolIds: pool.map((p) => p.id),
    kindTool,
    scenarios,
    byUrl,
    report: { total: g.pool.length, resolved: byUrl.size, unresolved, unresolvedFrac: +frac.toFixed(3), titleMismatch, via },
  };
}

/** Relação-gabarito de um id num cenário resolvido ('none' p/ fora do pool — mesma regra do v2). */
export function gtRelation(scenario, id) {
  return scenario.labels.get(id) ?? 'none';
}

/** Formato do golden.json v2 (ids) — p/ o harness antigo (run-eval.mjs) rodar sobre o v3 sem reescrita. */
export function toLegacyShape(resolved, { focusOnly = false } = {}) {
  return {
    pool: resolved.poolIds.slice(),
    kindTool: [...resolved.kindTool],
    scenarios: resolved.scenarios.map((s) => {
      const keep = focusOnly ? new Set(s.focus) : null;
      const f = (ids) => (keep ? ids.filter((id) => keep.has(id)) : ids.slice());
      return { id: s.id, query: s.query, direct: f(s.direct), similar: f(s.similar), ...(keep ? { pool: s.focus.slice() } : {}) };
    }),
  };
}

/**
 * Tudo junto: lê + valida (lança com a lista de erros) + resolve. Abre o banco read-only quando o
 * chamador não passa `db`, e fecha o que abriu.
 */
export async function loadGolden({ file = GOLDEN_V3_PATH, db = null, dbPath = null, ...opts } = {}) {
  const g = readGolden(file);
  const v = validateGolden(g);
  if (!v.ok) {
    const e = new Error(`golden v3 inválido (${v.errors.length} erro(s)): ${v.errors.slice(0, 5).join('; ')}`);
    e.code = 'GOLDEN_INVALID';
    e.errors = v.errors;
    throw e;
  }
  let handle = db;
  let opened = false;
  if (!handle) {
    const { default: Database } = await import('better-sqlite3');
    handle = new Database(dbPath || defaultDbPath(), { readonly: true, fileMustExist: true });
    opened = true;
  }
  try {
    return resolveGolden(g, handle, opts);
  } finally {
    if (opened) handle.close();
  }
}

// ---- CLI: relatório de resolução (sem LLM, sem escrita) ----

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) {
      out[k] = next;
      i++;
    } else out[k] = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args.file ? path.resolve(String(args.file)) : GOLDEN_V3_PATH;
  const dbPath = args.db ? path.resolve(String(args.db)) : defaultDbPath();
  let res;
  try {
    res = await loadGolden({ file, dbPath });
  } catch (e) {
    errorLog(e.message);
    if (e.errors) for (const m of e.errors) errorLog(`  - ${m}`);
    if (e.unresolved) for (const u of e.unresolved) errorLog(`  não resolveu: ${u}`);
    process.exitCode = 1;
    return;
  }
  const { report } = res;
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ...report, scenarios: res.scenarios.map((s) => ({ id: s.id, direct: s.direct.length, similar: s.similar.length, focus: s.focus.length })) }, null, 2)}\n`);
    return;
  }
  log(`golden v3 (${path.relative(process.cwd(), file) || file}) contra ${dbPath}`);
  log(`  resolvidas ${report.resolved}/${report.total} (exato ${report.via.exact}, normalizado ${report.via.normalized}, caixa-do-path ${report.via.loose})`);
  for (const u of report.unresolved) warn(`  NÃO resolveu: ${u}`);
  for (const m of report.titleMismatch) warn(`  título divergente (sim ${m.sim}) id=${m.id}: "${m.golden}" ≠ "${m.db}"`);
  for (const s of res.scenarios) {
    log(`  ${s.id} [${s.lang}] direct=${s.direct.length} similar=${s.similar.length} foco=${s.focus.length} — ${s.query}`);
  }
}

// Só roda o CLI quando executado direto (import pelo teste/harness não imprime nada).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
