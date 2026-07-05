// Reprodução client-side do WEB_WHERE (src/db.js:213-238 do CLI) sobre o snapshot: fonte,
// período (date_iso já vem resolvido do export — published_at normalizado com fallback em
// extracted_at, então NUNCA é null), kind de 3 vias (release = coluna exata; news/tool =
// coluna vence, fallback por tags) e verify. Módulo PURO (testável com node --test, sem React/DOM).
//
// DIVERGÊNCIA DELIBERADA do WEB_WHERE (só no webapp): as facetas fazem INTERSEÇÃO (AND) puro —
// AND dentro da faceta E entre facetas — em vez do "AND-de-OR" do SQL. Escolha de produto do
// site público: selecionar duas tags = itens que têm AS DUAS. NÃO "ressincronize" para OR sem
// checar o pedido (o web-ui SQL local segue OR; são superfícies distintas). Ver computeFacetCounts.
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
    // INTERSEÇÃO (AND) total: o artigo tem de conter TODA tag selecionada (dentro da faceta e
    // entre facetas). Duas tags marcadas = só quem tem as duas. (Diverge do OR-dentro-da-faceta
    // do WEB_WHERE — ver cabeçalho.)
    for (const [facet, tags] of facetEntries) {
      const have = a.tags?.[facet];
      if (!have || !tags.every((t) => have.includes(t))) return false;
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

/**
 * Contagem de co-ocorrência por faceta/tag sobre um conjunto JÁ FILTRADO `R` (o resultado do
 * browse atual). Para cada tag T devolve quantos itens de `R` também têm T.
 *
 * Como `R` já exige TODA tag selecionada (applyFilters faz interseção), o tally responde de graça
 * às três perguntas da UI: tag SELECIONADA → |R| (todos de R a têm → sobe ao topo); tag da mesma
 * faceta/outra faceta que CO-OCORRE → a interseção com a seleção; tag que não aparece em nenhum
 * item de R → ausente (0) → a UI a desabilita. Passe SEMPRE o conjunto já filtrado, não o acervo.
 *
 * Retorna `{ [faceta]: { [tag]: n } }`. O(|R| × tags/artigo) — barato p/ o snapshot inteiro.
 */
export function computeFacetCounts(articles) {
  const counts = {};
  for (const a of articles) {
    const tags = a.tags;
    if (!tags) continue;
    for (const facet in tags) {
      const list = tags[facet];
      if (!list) continue;
      const bucket = counts[facet] || (counts[facet] = {});
      for (const tag of list) bucket[tag] = (bucket[tag] || 0) + 1;
    }
  }
  return counts;
}

/** Ordenação de exibição do browse: data DESC, id DESC (o snapshot vem por id ASC). */
export function sortForDisplay(articles) {
  return [...articles].sort((x, y) => {
    if (x.date_iso !== y.date_iso) return x.date_iso < y.date_iso ? 1 : -1;
    return y.id - x.id;
  });
}
