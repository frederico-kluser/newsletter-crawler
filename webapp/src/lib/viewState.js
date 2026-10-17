// Persistência fail-open da posição de leitura e estado de filtros do site (localStorage via
// storage.js). Salva: filtros estruturados, busca textual local, quantidade de itens paginados
// (visibleCount), posição Y do scroll e ID do card-âncora no topo da viewport.
// Módulo PURO nas funções de sanitização/serialização — testável com node:test sem DOM.
import { EMPTY_FILTERS } from './filters.js';
import { clearViewState, getViewStateRaw, setViewStateRaw } from './storage.js';

export const VIEW_STATE_VERSION = 1;
export const DEFAULT_PAGE_SIZE = 24;
export const MAX_RESTORED_VISIBLE = 600;

const VALID_KINDS = new Set(['all', 'news', 'tool', 'release']);
const VALID_VERIFIES = new Set(['', 'ok', 'suspect', 'junk']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sanitizeDate(val, fallback = '') {
  if (typeof val !== 'string') return fallback;
  const trimmed = val.trim();
  if (trimmed === '') return '';
  return ISO_DATE_RE.test(trimmed) ? trimmed : fallback;
}

/**
 * Sanitiza um objeto de filtros arbitrário (vindo do localStorage) garantindo todas as chaves
 * do contrato de `EMPTY_FILTERS` e preservando `from: ''` quando o usuário limpou a data inicial.
 */
export function sanitizeFilters(raw, fallback = EMPTY_FILTERS) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...fallback, sourceIds: [...(fallback.sourceIds || [])], facets: {} };
  }

  const sourceIds = Array.isArray(raw.sourceIds)
    ? [...new Set(raw.sourceIds.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))]
    : [...(fallback.sourceIds || [])];

  const from = Object.prototype.hasOwnProperty.call(raw, 'from')
    ? sanitizeDate(raw.from, fallback.from)
    : fallback.from;

  const to = Object.prototype.hasOwnProperty.call(raw, 'to')
    ? sanitizeDate(raw.to, fallback.to)
    : fallback.to;

  const kind = VALID_KINDS.has(raw.kind) ? raw.kind : fallback.kind;
  const verify = VALID_VERIFIES.has(raw.verify) ? raw.verify : fallback.verify;
  const showJunk = typeof raw.showJunk === 'boolean' ? raw.showJunk : Boolean(fallback.showJunk);

  const facets = {};
  if (raw.facets && typeof raw.facets === 'object' && !Array.isArray(raw.facets)) {
    for (const [facet, list] of Object.entries(raw.facets)) {
      if (!facet || !Array.isArray(list)) continue;
      const cleanTags = [...new Set(list.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()))];
      if (cleanTags.length > 0) facets[facet] = cleanTags;
    }
  }

  return {
    sourceIds,
    from,
    to,
    facets,
    kind,
    verify,
    showJunk,
  };
}

export function sanitizeVisibleCount(val, page = DEFAULT_PAGE_SIZE) {
  const n = Math.round(Number(val));
  if (!Number.isFinite(n) || n <= page) return page;
  return Math.min(n, MAX_RESTORED_VISIBLE);
}

export function sanitizeScrollY(val) {
  const n = Math.round(Number(val));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

export function sanitizeAnchorId(val) {
  const n = Number(val);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Estado padrão limpo quando não há sessão salva ou após reset explícito. */
export function createDefaultViewState(page = DEFAULT_PAGE_SIZE) {
  return {
    v: VIEW_STATE_VERSION,
    filters: sanitizeFilters(null),
    textInput: '',
    visibleCount: page,
    scrollY: 0,
    anchorId: null,
    restored: false,
  };
}

/** Carrega e valida o estado salvo no storage. Nunca lança exceção. */
export function loadViewState(page = DEFAULT_PAGE_SIZE) {
  const raw = getViewStateRaw();
  if (!raw) return createDefaultViewState(page);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.v !== VIEW_STATE_VERSION) {
      return createDefaultViewState(page);
    }
    const filters = sanitizeFilters(parsed.filters);
    const textInput = typeof parsed.textInput === 'string' ? parsed.textInput.slice(0, 240) : '';
    const visibleCount = sanitizeVisibleCount(parsed.visibleCount, page);
    const scrollY = sanitizeScrollY(parsed.scrollY);
    const anchorId = sanitizeAnchorId(parsed.anchorId);
    return {
      v: VIEW_STATE_VERSION,
      filters,
      textInput,
      visibleCount,
      scrollY,
      anchorId,
      restored: true,
    };
  } catch {
    return createDefaultViewState(page);
  }
}

/** Grava o estado atual de navegação no storage. */
export function saveViewState(state, page = DEFAULT_PAGE_SIZE) {
  if (!state || typeof state !== 'object') return false;
  try {
    const payload = {
      v: VIEW_STATE_VERSION,
      filters: sanitizeFilters(state.filters),
      textInput: typeof state.textInput === 'string' ? state.textInput.slice(0, 240) : '',
      visibleCount: sanitizeVisibleCount(state.visibleCount, page),
      scrollY: sanitizeScrollY(state.scrollY),
      anchorId: sanitizeAnchorId(state.anchorId),
      updatedAt: Date.now(),
    };
    setViewStateRaw(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/** Limpa o estado persistido no storage. */
export function resetViewState() {
  clearViewState();
}
