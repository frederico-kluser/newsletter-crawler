// Reprodução client-side do WEB_WHERE (src/db.js:213-238 do CLI) sobre o snapshot: fonte,
// período (date_iso já vem resolvido do export — published_at normalizado com fallback em
// extracted_at, então NUNCA é null), facetas AND-de-OR, kind de 3 vias (release = coluna
// exata; news/tool = coluna vence, fallback por tags) e verify. Módulo PURO (testável com
// node --test, sem React/DOM).
import { articleIsTool } from './taxonomy.js';

export const EMPTY_FILTERS = Object.freeze({
  sourceId: null,
  from: '',
  to: '',
  facets: {},
  kind: 'all',
  verify: '',
});

/** Filtros ativos (para o badge "Filtros (n)" e as pills). Kind fica fora — mora no Segmented. */
export function countActiveFilters(f) {
  let n = 0;
  if (f.sourceId != null) n++;
  if (f.from || f.to) n++;
  if (f.verify) n++;
  for (const tags of Object.values(f.facets || {})) n += tags.length;
  return n;
}

/** Aplica os filtros de browse. `toolTypes` vem de meta.toolContentTypes. */
export function applyFilters(articles, f, toolTypes) {
  const facetEntries = Object.entries(f.facets || {}).filter(([, tags]) => tags && tags.length);
  return articles.filter((a) => {
    if (f.sourceId != null && a.source_id !== f.sourceId) return false;
    if (f.from && a.date_iso < f.from) return false;
    if (f.to && a.date_iso > f.to) return false;
    // AND entre facetas, OR dentro da faceta (espelho do NOT EXISTS duplo do SQL)
    for (const [facet, tags] of facetEntries) {
      const have = a.tags?.[facet];
      if (!have || !tags.some((t) => have.includes(t))) return false;
    }
    if (f.kind && f.kind !== 'all') {
      if (f.kind === 'release') {
        if (a.kind !== 'release') return false;
      } else if ((f.kind === 'tool') !== articleIsTool(a, toolTypes)) {
        return false;
      }
    }
    if (f.verify && a.verify_status !== f.verify) return false;
    return true;
  });
}

/** Ordenação de exibição do browse: data DESC, id DESC (o snapshot vem por id ASC). */
export function sortForDisplay(articles) {
  return [...articles].sort((x, y) => {
    if (x.date_iso !== y.date_iso) return x.date_iso < y.date_iso ? 1 : -1;
    return y.id - x.id;
  });
}
