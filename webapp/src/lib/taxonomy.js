// Semântica de "ferramenta" espelhada do CLI (src/taxonomy.js isToolByTags + o CASE do
// WEB_WHERE em src/db.js): aqui as tags já chegam agrupadas {faceta:[tags]} (shape do export)
// e o vocabulário de content-types de ferramenta vem do meta.json (toolContentTypes) — fonte
// única no repo, sem constante duplicada.

/** Artigo é "sobre ferramenta" pelas tags: faceta framework-library-tool OU content-type do set. */
export function isToolByTags(tags, toolTypes) {
  if (!tags) return false;
  if (tags['framework-library-tool']?.length) return true;
  const ct = tags['content-type'];
  return Boolean(ct && ct.some((t) => toolTypes.includes(t)));
}

/** Bucket amplo tool/news: a coluna `kind` curada VENCE as tags; release conta como tool. */
export function articleIsTool(a, toolTypes) {
  if (a.kind === 'tool' || a.kind === 'release') return true;
  if (a.kind === 'news') return false;
  return isToolByTags(a.tags, toolTypes);
}

/** Kind exibido no badge do card (coluna crua; NULL cai no fallback por tags). */
export function effectiveKind(a, toolTypes) {
  return a.kind || (isToolByTags(a.tags, toolTypes) ? 'tool' : 'news');
}
