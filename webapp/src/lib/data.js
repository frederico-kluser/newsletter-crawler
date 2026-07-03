// ÚNICA fronteira de dados do app: o snapshot estático em /data/*.json (gerado pelo CLI com
// `ncrawl export --format web` e commitado). Promises memoizadas = 1 fetch por sessão;
// contents.json é LAZY (só baixa ao abrir um preview ou rodar busca profunda). Trocar o
// backend de dados no futuro (ex.: IndexedDB do PLANO-WEBAPP) = trocar só este módulo.

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
export const loadArticles = memo(() => fetchJson('/data/articles.json'));
export const loadContents = memo(() => fetchJson('/data/contents.json'));

/** Corpo completo de um artigo (baixa contents.json na 1ª chamada). */
export async function getContent(id) {
  const contents = await loadContents();
  return contents[id] ?? '';
}
