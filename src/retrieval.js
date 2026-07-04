// Camada de RECUPERAÇÃO (retrieval) sobre o acervo. Começa pela metade LÉXICA (FTS5/BM25): um
// gerador de candidatos que troca a varredura O(n_artigos) por LLM em tempo de busca por uma
// consulta de índice + top-K. A metade DENSA (embeddings + sqlite-vec), a fusão RRF e o rerank
// por cross-encoder entram nos próximos incrementos e se combinam aqui.
import { stmts, VEC_OK } from './db.js';
import { embedQuery, toBlob } from './embed.js';
import { RRF_K, RERANK_ENABLED, RERANK_POOL, RERANK_KEEP } from './config.js';
import { rerankScores } from './rerank.js';
import { debug } from './util.js';

// Converte texto livre num MATCH SEGURO do FTS5. Tokeniza em \p{L}\p{N} (então nenhum caractere
// especial do FTS — aspas, -, *, (), : — sobrevive), descarta tokens < 2 chars, e cita cada termo
// (a citação neutraliza os operadores AND/OR/NOT/NEAR virando literal E preserva o stemming do
// porter dentro da "frase" de 1 token). Une por OR: recall AMPLO p/ candidatos — o BM25 ranqueia
// quem casa mais termos / termos mais raros. Consulta sem termos -> null (o chamador devolve []).
export function toFtsMatch(query) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2)
    .slice(0, 24);
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * Recuperação LÉXICA: top-N ids do acervo por BM25, com escopo opcional (fontes/período).
 * Nunca lança por consulta malformada (toFtsMatch já sanitiza); consulta vazia -> [].
 * @returns {{id:number, score:number}[]} score = bm25 (mais NEGATIVO = mais relevante).
 */
export function retrieveLexical(query, { limit = 100, sources = null, from = null, to = null } = {}) {
  const match = toFtsMatch(query);
  if (!match) return [];
  return stmts.searchFts.all({
    q: match,
    limit,
    sources: sources && sources.length ? JSON.stringify(sources) : null,
    from,
    to,
  });
}

/**
 * Pré-filtro de candidatos p/ a busca IA: quando `rows` (o escopo) é MAIOR que `k`, devolve só os
 * top-K por BM25 (ordenados, mais relevante primeiro) — o LLM julga esses em vez do acervo todo.
 * Escopo <= k, consulta vazia, ou FTS sem match => devolve `rows` INTACTO (fail-open, sem regressão
 * de recall). Puro/testável (só depende de `rows[i].id`).
 * @returns {{rows: any[], scope: number, prefiltered: boolean}}
 */
export function prefilterCandidates(rows, query, { k = 200, sources = null, from = null, to = null } = {}) {
  const scope = rows.length;
  if (!query || scope <= k) return { rows, scope, prefiltered: false };
  const cand = retrieveLexical(query, { limit: k, sources, from, to });
  if (!cand.length) return { rows, scope, prefiltered: false };
  const rank = new Map(cand.map((c, i) => [c.id, i]));
  const filtered = rows.filter((r) => rank.has(r.id));
  if (!filtered.length) return { rows, scope, prefiltered: false };
  filtered.sort((a, b) => rank.get(a.id) - rank.get(b.id)); // BM25: mais relevante primeiro
  return { rows: filtered, scope, prefiltered: true };
}

/**
 * Recuperação DENSA (embeddings + sqlite-vec KNN): top-N ids por similaridade de cosseno. Nunca
 * lança; sem sqlite-vec / consulta vazia / falha do modelo => []. @returns {{id:number,distance:number}[]}
 */
export async function retrieveDense(query, { limit = 200 } = {}) {
  if (!VEC_OK || !query) return [];
  try {
    const v = await embedQuery(query);
    if (!v) return [];
    return stmts.knnVec.all(toBlob(v), limit);
  } catch (e) {
    debug(`retrieveDense falhou (${e.message}); seguindo só com o léxico`);
    return [];
  }
}

/**
 * Reciprocal Rank Fusion: combina listas ranqueadas (cada uma best-first) num score
 * Σ 1/(k + rank). `keep` (Set) restringe ao escopo. Puro/testável. @returns {{id,score}[]}
 */
export function fuseRRF(lists, { keep = null, k = RRF_K } = {}) {
  const score = new Map();
  for (const list of lists) {
    list.forEach((it, rank) => {
      if (keep && !keep.has(it.id)) return;
      score.set(it.id, (score.get(it.id) || 0) + 1 / (k + rank));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id, s]) => ({ id, score: s }));
}

// Texto do documento p/ o rerank: título + um trecho (resumo/blurb/cabeça do conteúdo).
const rerankText = (r) =>
  `${r.title || ''}. ${(r.summary_pt || r.blurb || r.content_head || r.content || '').slice(0, 500)}`.trim();

/** Reordena `rows` por `scores` (alinhados) desc e trunca em `keep`. Puro/testável. */
export function reorderByScores(rows, scores, keep = rows.length) {
  return rows
    .map((r, i) => ({ r, s: scores[i] ?? -Infinity }))
    .sort((a, b) => b.s - a.s)
    .slice(0, keep)
    .map((x) => x.r);
}

// Rerank cross-encoder do TOPO da lista RRF (precisão). Fail-open: modelo ausente/erro => mantém a
// ordem RRF (applied:false). Reranqueia só o top RERANK_POOL (latência) e mantém RERANK_KEEP.
async function applyRerank(query, rows) {
  if (rows.length <= 1) return { rows, applied: false };
  const head = rows.slice(0, RERANK_POOL);
  const scores = await rerankScores(query, head.map(rerankText));
  if (!scores) return { rows, applied: false };
  return { rows: reorderByScores(head, scores, RERANK_KEEP), applied: true };
}

/**
 * Candidatos HÍBRIDOS p/ a busca IA: escopo > k => funde léxico (FTS/BM25) ⊕ denso (embeddings)
 * por RRF e devolve o top-K (o LLM julga só esses). Fail-open: escopo <= k, consulta vazia, ou
 * fusão vazia => `rows` INTACTO. Sem embeddings (sqlite-vec off / base não-vetorizada) => cai p/
 * só-léxico SEM carregar o modelo. @returns {{rows:any[],scope:number,prefiltered:boolean,mode:string}}
 */
export async function hybridCandidates(rows, query, { k = 200, sources = null, from = null, to = null } = {}) {
  const scope = rows.length;
  if (!query || scope <= k) return { rows, scope, prefiltered: false, mode: 'none' };
  const keep = new Set(rows.map((r) => r.id));
  const lex = retrieveLexical(query, { limit: k, sources, from, to });
  const hasVectors = VEC_OK && stmts.countVec && stmts.countVec.get().c > 0;
  const dense = hasVectors ? await retrieveDense(query, { limit: k }) : [];
  const fused = fuseRRF([lex, dense], { keep });
  if (!fused.length) return { rows, scope, prefiltered: false, mode: 'none' };
  const order = new Map(fused.slice(0, k).map((f, i) => [f.id, i]));
  const filtered = rows.filter((r) => order.has(r.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
  const mode = lex.length && dense.length ? 'hybrid' : dense.length ? 'dense' : 'lexical';
  const rr = RERANK_ENABLED ? await applyRerank(query, filtered) : { rows: filtered, applied: false };
  return { rows: rr.rows, scope, prefiltered: true, mode, reranked: rr.applied };
}
