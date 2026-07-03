// Busca de texto LOCAL (sem IA): o modo base do buscador, funciona SEM chave da OpenRouter.
// Acento-insensível (fold NFD, como o foldText removido do CLI) e por TERMOS (AND): o artigo
// casa se cada termo da consulta aparece em algum campo textual (título, resumos, snippet,
// seção, fonte, tags). É literal — sem semântica; a "inteligência" é a busca IA opcional.

/** Remove acentos e baixa a caixa. */
export function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // marcas de combinação (acentos) separadas pelo NFD
    .toLowerCase();
}

/** String "palheiro" de um artigo (todos os campos textuais + tags), já dobrada. */
export function buildHaystack(a) {
  const tags = a.tags ? Object.values(a.tags).flat() : [];
  return fold([a.title, a.title_pt, a.summary_pt, a.snippet, a.section, a.source_name, ...tags].join(' '));
}

const haystackOf = (a) => (a._search != null ? a._search : buildHaystack(a));

/** Divide a consulta em termos dobrados (espaços). */
export const termsOf = (query) => fold(query).split(/\s+/).filter(Boolean);

/** Um artigo casa se TODOS os termos aparecem no palheiro. Consulta vazia = casa tudo. */
export function matchesText(a, terms) {
  if (!terms.length) return true;
  const hay = haystackOf(a);
  return terms.every((t) => hay.includes(t));
}

/** Filtra a lista pela consulta textual (usa `_search` pré-computado quando existe). */
export function searchText(list, query) {
  const terms = termsOf(query);
  if (!terms.length) return list;
  return list.filter((a) => matchesText(a, terms));
}
