// API pública JSON do acervo. O `ncrawl export --format web` também gera ISTO: UM arquivo
// self-contained em webapp/public/api/v1/corpus.json, servido pela Vercel em /api/v1/corpus.json
// com CORS aberto (webapp/vercel.json) — um contrato ESTÁVEL e versionado (v1, aditivo-only) p/
// qualquer site/serviço externo consumir notícias, techs e resumos. É irmão do snapshot INTERNO
// do webapp (export-web.js), de propósito desacoplado dele: mudar o site não quebra quem consome
// a API. Metadados + resumos + tags, SEM o corpo completo dos artigos (leve, ~1 fetch).
// Determinístico: id ASC do SQL + stringify estável; único campo volátil = generatedAt (espelha
// export-web.js, p/ o guard anti-ruído do .githooks/pre-push funcionar).
//
// GUARD ANTI-ENCOLHIMENTO: quem barra um snapshot que apagaria o acervo é `exportWebSnapshot`
// (src/export-web.js), e ele roda SEMPRE ANTES daqui nos dois chamadores (`cmdExport` em
// commands.js e o `ncrawl deploy`) — bloqueado lá, LANÇA e este writer nem é alcançado, então o
// corpus.json commitado fica intacto. Mantenha essa ordem ao mexer num chamador: exportar a API
// pública ANTES do snapshot web tiraria o corpus.json de trás do guard.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stmts } from './db.js';
import { getFacets } from './taxonomy.js';
import { redactSecrets } from './redact.js';
import { log } from './util.js';

// Teto por blurb e teto DURO do corpus.json (MB). O corpus é COMMITADO a cada deploy e o GitHub
// rejeita blobs > 100 MB (GH001); ao contrário do contents do snapshot interno, ele não se fatia —
// então o único guard possível é fail-closed, com a saída acionável na mensagem. Os números
// espelham export-web.js de propósito (os dois exports são irmãos DESACOPLADOS: constante local,
// não import, p/ mexer num não mudar o outro em silêncio).
const BLURB_MAX_CHARS = 4000;
const CORPUS_HARD_CAP_MB = 95;

const capBlurb = (raw) => {
  const s = raw == null ? '' : String(raw);
  return s ? s.slice(0, BLURB_MAX_CHARS) : null;
};

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

  // proveniência (issue_url + blurb) por artigo: vem do PRÓPRIO SELECT (stmts.webExportArticles),
  // numa query só. A versão anterior varria `listArticlesBySource` fonte a fonte e deixava de fora
  // o artigo com `source_id` NULO — que é exatamente o que um restore deste corpus produz quando a
  // fonte não pôde ser remapeada, ou seja, perdia a proveniência de quem mais precisa dela.
  const rows = stmts.webExportArticles.all();

  // artigos: acervo COMPLETO (id ASC), contrato v1 em camelCase; NUNCA omite campo (null quando
  // pendente). Sem corpo completo — só o snippet (preview 400ch, whitespace normalizado p/
  // espelhar o snippet() da busca). byKind é contado aqui (determinístico, ordem de chave fixa).
  const byKind = { news: 0, tool: 0, release: 0, unknown: 0 };
  const articles = rows.map((a) => {
    const kind = a.kind || null;
    byKind[kind && kind in byKind ? kind : 'unknown'] += 1;
    return {
      id: a.id,
      url: a.url,
      sourceId: a.source_id,
      sourceName: sourceName.get(a.source_id) || null,
      title: redactSecrets(a.title),
      titlePt: redactSecrets(a.title_pt),
      summaryPt: redactSecrets(a.summary_pt),
      snippet: redactSecrets(String(a.snippet || '').replace(/\s+/g, ' ').trim()),
      // v1 ADITIVO: proveniência do item na newsletter de origem. `issueUrl` = a issue/edição de
      // onde a curadoria o cadastrou (é o que devolve a parada de paginação num restore, sem
      // re-curar ~600 issues por IA) e `blurb` = a descrição CRUA do próprio agregador. Ambos
      // passam pela redação de segredos, como o resto da superfície pública.
      // Aqui o `blurb` sai SEMPRE, mesmo repetindo o começo do `snippet` — ao contrário do snapshot
      // interno (export-web.js), que manda um OU outro. Motivo: `snippet` é `required` e não-nulo no
      // contrato v1 PUBLICADO, e um `blurb` que só aparece "quando não cabe no snippet" seria lido
      // como "este item não tem blurb" por quem consome a API de fora. O custo (~9% do corpus.json)
      // é o preço de um contrato externo sem regra derivada; quem precisa do snapshot enxuto usa o
      // /data/articles.json, que é o formato interno e vem com o leitor junto.
      issueUrl: redactSecrets(a.issue_url ?? null),
      blurb: redactSecrets(capBlurb(a.blurb)),
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
  // Teto ANTES da escrita (fail-closed): um corpus acima do limite não pode nem chegar ao disco,
  // de onde o deploy o commitaria e o push seria rejeitado longe daqui.
  const bytes = Buffer.byteLength(json);
  if (bytes > CORPUS_HARD_CAP_MB * 1024 * 1024) {
    throw new Error(
      `export api: corpus.json ficou com ${(bytes / 1024 / 1024).toFixed(1)} MB ` +
        `(${corpus.articles.length} artigos) — acima do teto duro de ${CORPUS_HARD_CAP_MB} MB; o GitHub ` +
        `rejeitaria o push (GH001, blob > 100 MB). Saídas: PAGINE a API pública (v2 com /api/v1/corpus.partN.json) ` +
        `ou corte campos por artigo — nenhum dos dois pode ser feito em tempo de export.`,
    );
  }
  writeFileSync(path.join(outDir, 'corpus.json'), json);
  log(
    `export api: ${corpus.articles.length} artigos → ${outDir} ` +
      `(corpus.json, ${(bytes / 1024 / 1024).toFixed(2)} MB brutos)`,
  );
  return { articles: corpus.articles.length, bytes };
}
