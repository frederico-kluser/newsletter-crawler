// Amostragem SOMENTE-LEITURA do banco real p/ o eval Jev (gold grátis da era DeepSeek:
// verify_status, article_tags, kind/section dos itens curados, title_pt/summary_pt).
//
// Regras duras:
// - NUNCA escreve no banco de origem: abre com better-sqlite3 {readonly:true, fileMustExist:true}
//   + PRAGMA query_only. Por isso NÃO importa src/db.js — aquele módulo ABRE o DB_PATH em escrita
//   no import (migrações aditivas + rebuild do FTS) e o acervo do usuário já foi perdido 2× por
//   efeito colateral. Pelo mesmo motivo não importa src/config.js (cria/semeia o NC_HOME e carrega
//   o .env). O SQL mora no objeto único `Q` abaixo (o espelho da regra do `stmts` de src/db.js).
// - Amostragem DETERMINÍSTICA: nada de Math.random. A ordem é o sha256(seed + id), então a mesma
//   seed devolve a mesma amostra hoje e daqui a um mês (e o cache por sha continua batendo);
//   trocar a seed dá uma amostra nova e independente.
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

export const DEFAULT_SEED = 'jev-eval-v1';

/** Banco de origem: EVAL_SOURCE_DB (relativo ao cwd) ou NC_HOME/crawler.db (default ~/.newsletter-crawler). */
export function resolveSourceDb(env = process.env) {
  if (env.EVAL_SOURCE_DB) return path.resolve(env.EVAL_SOURCE_DB);
  const home = env.NC_HOME ? path.resolve(env.NC_HOME) : path.join(os.homedir(), '.newsletter-crawler');
  return path.join(home, 'crawler.db');
}

/** Abre o banco de origem em SOMENTE-LEITURA (lança se o arquivo não existir). */
export function openSourceDb(file = resolveSourceDb()) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  // Cinto + suspensório: mesmo que alguém troque a flag acima, a conexão recusa escrita.
  db.pragma('query_only = ON');
  return db;
}

// ---- ordem semeada (pura) ----

/** Posto determinístico de um item: sha256 hex de `${seed}\0${key}`. */
export function seededRank(seed, key) {
  return crypto.createHash('sha256').update(`${seed}\u0000${key}`).digest('hex');
}

/** Cópia ordenada pelo posto semeado (desempate pela própria chave, p/ ordem total). */
export function seededOrder(items, seed = DEFAULT_SEED, keyOf = (x) => x.id) {
  return items
    .map((item) => {
      const key = String(keyOf(item));
      return { item, key, rank: seededRank(seed, key) };
    })
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((x) => x.item);
}

/** Os `n` primeiros na ordem semeada (n ausente/Infinity = todos, embaralhados pela seed). */
export function seededSample(items, n, seed = DEFAULT_SEED, keyOf = (x) => x.id) {
  const ordered = seededOrder(items, seed, keyOf);
  return Number.isFinite(n) ? ordered.slice(0, Math.max(0, n)) : ordered;
}

/**
 * Amostra estratificada semeada. `quotas` = {estrato: n} (ordem das chaves = ordem da saída) ou
 * `perStratum` = n p/ todo estrato presente (ordem alfabética). Cada item volta com o seu estrato
 * em `stratum` (sem mutar o original); `shortfall` diz onde faltou item p/ a cota — estrato com
 * N pequeno precisa ser sinalizado no relatório, não escondido.
 */
export function stratifiedSample(items, { strataOf, quotas = null, perStratum = null, seed = DEFAULT_SEED, keyOf = (x) => x.id }) {
  const groups = new Map();
  for (const item of items) {
    const s = String(strataOf(item));
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(item);
  }
  const plan = quotas
    ? Object.entries(quotas)
    : [...groups.keys()].sort().map((s) => [s, perStratum ?? Infinity]);
  const picked = [];
  const shortfall = {};
  for (const [stratum, want] of plan) {
    const pool = groups.get(String(stratum)) || [];
    // A seed entra com o estrato: estratos diferentes não compartilham a mesma "sorte".
    const got = seededSample(pool, want, `${seed}|${stratum}`, keyOf);
    if (Number.isFinite(want) && got.length < want) shortfall[stratum] = { want, got: got.length };
    for (const item of got) picked.push({ ...item, stratum: String(stratum) });
  }
  return { items: picked, shortfall };
}

export const lengthBucket = (len) => (len < 1500 ? 'short' : len <= 6000 ? 'medium' : 'long');

// ---- SQL (objeto único; leitura apenas) ----
// IN de tamanho variável via json_each(?) — um único parâmetro, sem montar SQL por string.
const Q = {
  sources: 'SELECT id, name, base_url, type FROM sources ORDER BY id',
  articlesByIds:
    'SELECT id, source_id, url, title, content, published_at, kind, section, blurb, issue_url, ' +
    'verify_status, verify_notes, title_pt, summary_pt, run_id, content_source ' +
    'FROM articles WHERE id IN (SELECT value FROM json_each(?))',
  tagsByIds:
    'SELECT article_id, facet, tag, rank FROM article_tags ' +
    'WHERE article_id IN (SELECT value FROM json_each(?)) ORDER BY article_id, facet, rank',
  verifyCandidates:
    "SELECT id, verify_status AS gold, kind, source_id, length(content) AS len FROM articles " +
    "WHERE verify_status IN ('ok','suspect','junk')",
  classifiedCandidates:
    'SELECT a.id, a.verify_status, a.kind, length(a.content) AS len, ' +
    "(SELECT t.tag FROM article_tags t WHERE t.article_id = a.id AND t.facet = 'domain' ORDER BY t.rank LIMIT 1) AS domain " +
    'FROM articles a WHERE EXISTS (SELECT 1 FROM article_tags t WHERE t.article_id = a.id)',
  summaryCandidates:
    'SELECT id, kind, verify_status, length(content) AS len FROM articles ' +
    "WHERE title_pt IS NOT NULL AND title_pt <> '' AND summary_pt IS NOT NULL AND summary_pt <> ''",
  // Issue = (fonte, data): o issue_url dos restaurados é NULL (limitação conhecida do snapshot),
  // mas os itens de uma edição herdam a data dela. Só grupos com ≥1 item COM seção (curado).
  curatedIssues:
    'SELECT source_id, published_at, COUNT(*) AS n, SUM(section IS NOT NULL) AS with_section, ' +
    'MAX(issue_url) AS issue_url FROM articles ' +
    'WHERE kind IS NOT NULL AND published_at IS NOT NULL GROUP BY source_id, published_at ' +
    'HAVING SUM(section IS NOT NULL) > 0',
  issueItems:
    'SELECT id, url, title, kind, section, blurb, issue_url, published_at FROM articles ' +
    'WHERE source_id = ? AND published_at = ? AND kind IS NOT NULL ORDER BY id',
};

const _prepared = new WeakMap();
function stmt(db, name) {
  let cache = _prepared.get(db);
  if (!cache) {
    cache = {};
    _prepared.set(db, cache);
  }
  if (!cache[name]) cache[name] = db.prepare(Q[name]);
  return cache[name];
}

const clip = (s, max) => (max && typeof s === 'string' ? s.slice(0, max) : s);

/** Artigos completos na ORDEM dos ids pedidos (id ausente é pulado). */
export function loadArticles(db, ids, { maxContentChars = null } = {}) {
  if (!ids.length) return [];
  const byId = new Map(stmt(db, 'articlesByIds').all(JSON.stringify(ids)).map((r) => [r.id, r]));
  return ids.filter((id) => byId.has(id)).map((id) => {
    const r = byId.get(id);
    return { ...r, content: clip(r.content, maxContentChars) };
  });
}

/** Tags por artigo: Map id → {faceta: [tag por rank]}. */
export function loadTags(db, ids) {
  const out = new Map(ids.map((id) => [id, {}]));
  if (!ids.length) return out;
  for (const r of stmt(db, 'tagsByIds').all(JSON.stringify(ids))) {
    const facets = out.get(r.article_id);
    if (!facets) continue;
    (facets[r.facet] ||= []).push(r.tag);
  }
  return out;
}

export function listSources(db) {
  return stmt(db, 'sources').all();
}

/**
 * Registros de verificação com o veredito DeepSeek como gold (`gold` = ok|suspect|junk).
 * `quotas` ex.: {ok:30, suspect:30, junk:20}; sem quotas = `n` da população inteira.
 */
export function sampleVerifyRecords(db, { n = 80, quotas = null, seed = DEFAULT_SEED, maxContentChars = null } = {}) {
  const cands = stmt(db, 'verifyCandidates').all();
  const { items, shortfall } = quotas
    ? stratifiedSample(cands, { strataOf: (r) => r.gold, quotas, seed })
    : { items: seededSample(cands, n, seed).map((r) => ({ ...r, stratum: r.gold })), shortfall: {} };
  const full = new Map(loadArticles(db, items.map((r) => r.id), { maxContentChars }).map((a) => [a.id, a]));
  const records = items
    .filter((r) => full.has(r.id))
    .map((r) => ({ ...full.get(r.id), gold: r.gold, stratum: r.stratum }));
  return { records, shortfall };
}

/**
 * Artigos classificados com as tags DeepSeek como gold (`tags` = {faceta: [tag…]}) e `goldKind`.
 * Estrato default = a 1ª tag de `domain` ('(none)' sem domínio). `onlyVerifiedOk` restringe a
 * verify_status='ok' (gold mais limpa); `minContentChars` descarta stubs.
 */
export function sampleClassifiedArticles(
  db,
  { n = 120, perStratum = null, quotas = null, seed = DEFAULT_SEED, onlyVerifiedOk = false, minContentChars = 0, maxContentChars = null, strataOf = (r) => r.domain || '(none)' } = {},
) {
  let cands = stmt(db, 'classifiedCandidates').all();
  if (onlyVerifiedOk) cands = cands.filter((r) => r.verify_status === 'ok');
  if (minContentChars) cands = cands.filter((r) => (r.len || 0) >= minContentChars);
  const { items, shortfall } =
    perStratum != null || quotas
      ? stratifiedSample(cands, { strataOf, perStratum, quotas, seed })
      : { items: seededSample(cands, n, seed).map((r) => ({ ...r, stratum: String(strataOf(r)) })), shortfall: {} };
  const ids = items.map((r) => r.id);
  const full = new Map(loadArticles(db, ids, { maxContentChars }).map((a) => [a.id, a]));
  const tags = loadTags(db, ids);
  const records = items
    .filter((r) => full.has(r.id))
    .map((r) => ({ ...full.get(r.id), tags: tags.get(r.id) || {}, goldKind: full.get(r.id).kind, stratum: r.stratum }));
  return { records, shortfall };
}

/**
 * Edições curadas (gold = os itens que a curadoria DeepSeek salvou): [{issueKey, source_id,
 * source, published_at, issue_url, items:[{id,url,title,kind,section,blurb}]}]. Filtra por
 * `sources` (ids ou nomes exatos), `types` (ex.: ['index']) e `minItems`.
 */
export function sampleCuratedIssues(db, { n = 5, seed = DEFAULT_SEED, sources = null, types = null, minItems = 5 } = {}) {
  const srcRows = listSources(db);
  const srcById = new Map(srcRows.map((s) => [s.id, s]));
  const wanted = sources ? new Set(sources.map(String)) : null;
  let cands = stmt(db, 'curatedIssues')
    .all()
    .filter((r) => r.n >= minItems)
    .map((r) => ({ ...r, issueKey: `${r.source_id}|${r.published_at}` }));
  if (wanted) cands = cands.filter((r) => wanted.has(String(r.source_id)) || wanted.has(srcById.get(r.source_id)?.name));
  if (types) cands = cands.filter((r) => types.includes(srcById.get(r.source_id)?.type));
  return seededSample(cands, n, seed, (r) => r.issueKey).map((r) => ({
    issueKey: r.issueKey,
    source_id: r.source_id,
    source: srcById.get(r.source_id)?.name || null,
    published_at: r.published_at,
    issue_url: r.issue_url || null,
    items: stmt(db, 'issueItems').all(r.source_id, r.published_at),
  }));
}

/** Uma edição específica (fonte + data), p/ casos nomeados (ex.: Node Weekly 2026-08-27). */
export function loadIssue(db, { sourceId, publishedAt }) {
  const items = stmt(db, 'issueItems').all(sourceId, publishedAt);
  return { issueKey: `${sourceId}|${publishedAt}`, source_id: sourceId, published_at: publishedAt, items };
}

/**
 * Artigos com resumo PT-BR (gold/baseline = title_pt/summary_pt da era DeepSeek). Estrato por
 * `strataBy`: 'length' (short|medium|long), 'kind', 'verify' ou uma função.
 */
export function sampleSummaries(db, { n = 16, quotas = null, perStratum = null, strataBy = 'length', seed = DEFAULT_SEED, maxContentChars = null } = {}) {
  const strataOf =
    typeof strataBy === 'function'
      ? strataBy
      : strataBy === 'kind'
        ? (r) => r.kind || '(none)'
        : strataBy === 'verify'
          ? (r) => r.verify_status || '(none)'
          : (r) => lengthBucket(r.len || 0);
  const cands = stmt(db, 'summaryCandidates').all();
  const { items, shortfall } =
    quotas || perStratum != null
      ? stratifiedSample(cands, { strataOf, quotas, perStratum, seed })
      : { items: seededSample(cands, n, seed).map((r) => ({ ...r, stratum: String(strataOf(r)) })), shortfall: {} };
  const full = new Map(loadArticles(db, items.map((r) => r.id), { maxContentChars }).map((a) => [a.id, a]));
  const records = items.filter((r) => full.has(r.id)).map((r) => ({ ...full.get(r.id), stratum: r.stratum }));
  return { records, shortfall };
}
