// API pública JSON do acervo. O `ncrawl export --format web` também gera ISTO: UM arquivo
// self-contained em webapp/public/api/v1/corpus.json, servido pela Vercel em /api/v1/corpus.json
// com CORS aberto (webapp/vercel.json) — um contrato ESTÁVEL e versionado (v1, aditivo-only) p/
// qualquer site/serviço externo consumir notícias, techs e resumos. É irmão do snapshot INTERNO
// do webapp (export-web.js), de propósito desacoplado dele: mudar o site não quebra quem consome
// a API. Metadados + resumos + tags, SEM o corpo completo dos artigos (leve, ~1 fetch).
// Determinístico: id ASC do SQL + stringify estável; único campo volátil = generatedAt (espelha
// export-web.js, p/ o guard anti-ruído do .githooks/pre-push funcionar).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stmts } from './db.js';
import { getFacets } from './taxonomy.js';
import { log } from './util.js';

// Ordem canônica das facetas (taxonomy.json); fail-open p/ a ordem do banco — o export nunca pode
// cair por taxonomy.json ausente (mesma regra do export-web.js).
function orderedFacetNames(grouped) {
  try {
    const canonical = getFacets().map((f) => f.name);
    return [...canonical.filter((n) => grouped.has(n)), ...[...grouped.keys()].filter((n) => !canonical.includes(n))];
  } catch {
    return [...grouped.keys()];
  }
}

/** Monta o objeto do corpus público (puro sobre stmts; o writer fica em exportPublicApi). */
export function buildPublicApi() {
  // fontes: id -> nome (resolve name||base_url), reusado no bloco `sources` e p/ carimbar o artigo.
  const sources = stmts.webMetaSources.all().map((s) => ({ id: s.id, name: s.name || s.base_url, count: s.c }));
  const sourceName = new Map(sources.map((s) => [s.id, s.name]));

  // catálogo global de tags {faceta:[{tag,count}]} em ordem canônica.
  const grouped = new Map();
  for (const r of stmts.webMetaTags.all()) {
    if (!grouped.has(r.facet)) grouped.set(r.facet, []);
    grouped.get(r.facet).push({ tag: r.tag, count: r.c });
  }
  const facets = orderedFacetNames(grouped).map((name) => ({ name, tags: grouped.get(name) }));

  // tags POR artigo numa query só, agrupadas em {faceta:[tags]} (= webExportTags do snapshot web).
  const tagsByArticle = new Map();
  for (const r of stmts.webExportTags.all()) {
    let m = tagsByArticle.get(r.article_id);
    if (!m) tagsByArticle.set(r.article_id, (m = {}));
    (m[r.facet] ||= []).push(r.tag);
  }

  // artigos: acervo COMPLETO (id ASC), contrato v1 em camelCase; NUNCA omite campo (null quando
  // pendente). Sem corpo completo — só o snippet (preview 400ch, whitespace normalizado p/
  // espelhar o snippet() da busca). byKind é contado aqui (determinístico, ordem de chave fixa).
  const byKind = { news: 0, tool: 0, release: 0, unknown: 0 };
  const articles = stmts.webExportArticles.all().map((a) => {
    const kind = a.kind || null;
    byKind[kind && kind in byKind ? kind : 'unknown'] += 1;
    return {
      id: a.id,
      url: a.url,
      sourceId: a.source_id,
      sourceName: sourceName.get(a.source_id) || null,
      title: a.title,
      titlePt: a.title_pt,
      summaryPt: a.summary_pt,
      snippet: String(a.snippet || '').replace(/\s+/g, ' ').trim(),
      kind,
      section: a.section,
      date: a.date_iso,
      verifyStatus: a.verify_status,
      tags: tagsByArticle.get(a.id) || {},
    };
  });

  const dates = stmts.webMetaDates.get();
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    documentation: '/api/v1/README.md',
    schema: '/api/v1/schema.json',
    totals: {
      articles: stmts.countArticles.get().c,
      summaries: stmts.countSummaries.get().c,
      classified: stmts.countClassifications.get().c,
      byKind,
    },
    dates: { min: dates.min_d, max: dates.max_d },
    sources,
    facets,
    articles,
  };
}

/** Escreve corpus.json em `outDir`. Retorna { articles, bytes }. */
export function exportPublicApi({ outDir }) {
  const corpus = buildPublicApi();
  mkdirSync(outDir, { recursive: true });
  // Indent 1 = um campo por linha (diff de git legível); o gzip/brotli do deploy anula o custo.
  const json = JSON.stringify(corpus, null, 1) + '\n';
  writeFileSync(path.join(outDir, 'corpus.json'), json);
  const bytes = Buffer.byteLength(json);
  log(
    `export api: ${corpus.articles.length} artigos → ${outDir} ` +
      `(corpus.json, ${(bytes / 1024 / 1024).toFixed(2)} MB brutos)`,
  );
  return { articles: corpus.articles.length, bytes };
}
