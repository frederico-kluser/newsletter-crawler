// Matérias favoritas do webapp ESTÁTICO: persistem no NAVEGADOR (localStorage via storage.js),
// já que não há backend — mesmo padrão do histórico de buscas (lib/history.js). O payload guarda
// SÓ os ids (leves; a ficha é re-hidratada do snapshot pelo byId no App), em ordem de favoritação
// (novo→antigo). Payload versionado `{v:1, ids:[…]}`; corrupção/versão nova → lista vazia
// (fail-open) e quota cheia → poda os favoritos mais ANTIGOS até caber (nunca quebra o toggle).
//
// Além das funções puras, o módulo é um STORE mínimo com `subscribe`/`getFavoritesSnapshot` —
// snapshot `Set` cacheado e identidade estável entre mutações, o contrato do
// `useSyncExternalStore` (hooks/useFavorites.js): todos os cards + o filtro re-renderizam juntos.
import { getFavoritesRaw, trySetFavorites } from './storage.js';

const VERSION = 1;

let _snapshot = null; // Set<id> cacheado; identidade muda SÓ em mutação
const listeners = new Set();

/** Lê e valida o payload salvo; qualquer corrupção/versão nova vira lista vazia. */
export function loadFavorites() {
  const raw = getFavoritesRaw();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== VERSION || !Array.isArray(parsed.ids)) return [];
    return sanitizeIds(parsed.ids);
  } catch {
    return [];
  }
}

// Ids de artigo: inteiros positivos, sem repetição (preserva a ordem de chegada).
function sanitizeIds(ids) {
  const out = [];
  const seen = new Set();
  for (const raw of ids) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** Grava a lista podando os mais antigos (fim) SÓ se a quota recusar (retry até caber ou esvaziar). */
function persist(ids) {
  let list = sanitizeIds(ids);
  for (;;) {
    if (trySetFavorites(JSON.stringify({ v: VERSION, ids: list }))) return list;
    if (list.length <= 1) {
      // nem 1 id cabe: desiste de persistir, mantém o que der na sessão em memória
      trySetFavorites(JSON.stringify({ v: VERSION, ids: [] }));
      return [];
    }
    // poda ~20% do rabo (os favoritados há mais tempo) e re-tenta
    list = list.slice(0, Math.max(1, Math.floor(list.length * 0.8)));
  }
}

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // um listener com erro não pode derrubar os demais (fail-open)
    }
  }
}

/** Snapshot atual como Set (cacheado — identidade estável até à próxima mutação). */
export function getFavoritesSnapshot() {
  if (!_snapshot) _snapshot = new Set(loadFavorites());
  return _snapshot;
}

/** Inscreve para mudanças; devolve a função de cancelamento. */
export function subscribeFavorites(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function commit(ids) {
  const list = persist(ids);
  _snapshot = new Set(list);
  emit();
  return list;
}

/** O artigo `id` é favorito? */
export function isFavorite(id) {
  return getFavoritesSnapshot().has(id);
}

/** Liga/desliga o favorito; devolve o estado NOVO (true = ficou favorito). */
export function toggleFavorite(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return false;
  const cur = loadFavorites();
  const next = cur.includes(n) ? cur.filter((x) => x !== n) : [n, ...cur];
  commit(next);
  return next.includes(n);
}

/** Remove um favorito (idempotente); devolve a lista atualizada. */
export function removeFavorite(id) {
  const n = Number(id);
  return commit(loadFavorites().filter((x) => x !== n));
}

/** Esvazia os favoritos; devolve []. */
export function clearFavorites() {
  return commit([]);
}
