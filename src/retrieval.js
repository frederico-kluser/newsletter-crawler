// Camada de RECUPERAÇÃO (retrieval) sobre o acervo. Começa pela metade LÉXICA (FTS5/BM25): um
// gerador de candidatos que troca a varredura O(n_artigos) por LLM em tempo de busca por uma
// consulta de índice + top-K. A metade DENSA (embeddings + sqlite-vec), a fusão RRF e o rerank
// por cross-encoder entram nos próximos incrementos e se combinam aqui.
import { stmts } from './db.js';

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
