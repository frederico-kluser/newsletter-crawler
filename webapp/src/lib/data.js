// ÚNICA fronteira de dados do app: o snapshot estático em /data/*.json (gerado pelo CLI com
// `ncrawl export --format web` e commitado). Promises memoizadas = 1 fetch por sessão. O contents
// é FATIADO em partes (contents.partN.json — o mapa único passou de 100 MB e o GitHub rejeita
// blobs > 100 MB), então o corpo de um artigo é LAZY POR PARTE: lê meta.contentsParts (intervalo
// from..to de cada parte) e baixa SÓ a parte que contém o id, cacheada por parte. Trocar o
// backend de dados no futuro (ex.: IndexedDB do PLANO-WEBAPP) = trocar só este módulo.
import { buildHaystack } from './textSearch.js';

function memo(fn) {
  let p = null;
  // rejeição NÃO fica cacheada (senão um 404 transitório mataria o retry)
  return () => (p ||= fn().catch((e) => {
    p = null;
    throw e;
  }));
}

async function fetchJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

export const loadMeta = memo(() => fetchJson('/data/meta.json'));
// Pré-computa o "palheiro" da busca textual (fold NFD) UMA vez no load: a 1ª digitação já filtra
// sem construir ~600 haystacks na hora (a busca offline é síncrona; isto remove o hitch inicial).
export const loadArticles = memo(async () => {
  const rows = await fetchJson('/data/articles.json');
  for (const a of rows) a._search = buildHaystack(a);
  return rows;
});

// ---- contents em partes (map id→content fatiado; lazy por parte) ----
// Cache das partes já baixadas: 1 fetch por parte por sessão (a rejeição não fica cacheada, mesmo
// padrão do memo — um 404 transitório não mata o retry da parte).
const partCache = new Map();

function fetchPart(file) {
  let p = partCache.get(file);
  if (!p) {
    p = fetchJson(`/data/${file}`).catch((e) => {
      partCache.delete(file);
      throw e;
    });
    partCache.set(file, p);
  }
  return p;
}

/**
 * Localiza em `parts` (meta.contentsParts: [{file, from, to}], ordenadas por id crescente) a parte
 * cujo intervalo from..to contém `id`. null = id fora do snapshot ou snapshot sem contents.
 */
export function findPartForId(parts, id) {
  return parts.find((p) => p.from <= id && id <= p.to) || null;
}

/** Corpo completo de um artigo: baixa SÓ a parte que o contém (lazy, cacheado por parte). */
export async function getContent(id) {
  const meta = await loadMeta();
  const part = findPartForId(meta.contentsParts || [], id);
  if (!part) return ''; // sem conteúdo (snapshot antigo/vazio ou id desconhecido)
  const map = await fetchPart(part.file);
  return map[id] ?? '';
}
