// Snapshot JSON estático do acervo p/ o webapp (`ncrawl export --format web`): 3 arquivos em
// webapp/public/data — meta.json (totais/fontes/facetas/config da busca IA; ÚNICO com campo
// volátil, generatedAt), articles.json (campos de browse SEM content, id ASC) e contents.json
// (map id→content; o cliente só baixa ao abrir um preview ou rodar busca profunda).
// Determinístico de propósito: toda ordenação vem do SQL e o stringify é estável — re-exportar
// sem mudança na base gera bytes idênticos em articles/contents (diffs de git legíveis).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stmts } from './db.js';
import {
  MODELS, SEARCH_BATCH_SIZE, SEARCH_MAX_CHARS, SEARCH_WEB_MAX_ITEMS,
  SEARCH_MODE_A_CONFIRM, SEARCH_SOFT_CONFIRM, stageModel,
  SEARCH_WEB_SOFT_CONCURRENCY, SEARCH_WEB_DEEP_CONCURRENCY,
  SEARCH_UI_CONCURRENCY_DEFAULT, SEARCH_UI_CONCURRENCY_CEILING,
} from './config.js';
import { getFacets, TOOL_CONTENT_TYPES } from './taxonomy.js';
import { log } from './util.js';

// Média REAL de custo por chamada do estágio (>=3 amostras cobradas), senão null — o cliente cai
// nos seeds por tier. Mesma regra de estimateStageCallUsd (budget.js), mas aqui distinguimos a
// origem p/ OMITIR a chave quando só existiria o seed (o webapp tem os seeds hardcoded).
function costHint(stage) {
  try {
    const h = stmts.avgUsageByStage.get(stage);
    if (h && h.n >= 3 && h.avg > 0) return h.avg;
  } catch {
    /* base antiga sem llm_usage: sem hint */
  }
  return null;
}

/** Monta os 3 objetos do snapshot (puro sobre stmts; o writer fica em exportWebSnapshot). */
export function buildWebSnapshot() {
  // meta: espelho do apiMeta do web.js (fontes/facetas/datas/custo) + a config da busca IA,
  // p/ o webapp acompanhar mudanças de config/models.json com um re-export (sem deploy de código).
  const tagRows = stmts.webMetaTags.all();
  const grouped = new Map();
  for (const r of tagRows) {
    if (!grouped.has(r.facet)) grouped.set(r.facet, []);
    grouped.get(r.facet).push({ tag: r.tag, count: r.c });
  }
  // Ordem canônica da taxonomia; fail-open p/ a ordem do banco (como no web.js — o export
  // não pode cair por taxonomy.json ausente).
  let order = [...grouped.keys()];
  try {
    const canonical = getFacets().map((f) => f.name);
    order = [...canonical.filter((n) => grouped.has(n)), ...order.filter((n) => !canonical.includes(n))];
  } catch {
    /* mantém a ordem do banco */
  }
  const dates = stmts.webMetaDates.get();
  const usage = stmts.sumUsageTotal.get();
  const hints = { searchBatch: costHint('searchBatch'), searchRelevance: costHint('searchRelevance'), searchSpec: costHint('searchSpec') };
  const costHints = Object.fromEntries(Object.entries(hints).filter(([, v]) => v != null));

  const meta = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    totals: {
      articles: stmts.countArticles.get().c,
      summaries: stmts.countSummaries.get().c,
      classified: stmts.countClassifications.get().c,
    },
    cost: { totalUsd: usage.usd, totalCalls: usage.n },
    sources: stmts.webMetaSources.all().map((s) => ({ id: s.id, name: s.name || s.base_url, count: s.c })),
    facets: order.map((name) => ({ name, tags: grouped.get(name) })),
    dates: { min: dates.min_d, max: dates.max_d },
    toolContentTypes: [...TOOL_CONTENT_TYPES],
    search: {
      batchSize: SEARCH_BATCH_SIZE,
      maxChars: SEARCH_MAX_CHARS,
      maxItems: SEARCH_WEB_MAX_ITEMS,
      deepConfirm: SEARCH_MODE_A_CONFIRM,
      softConfirm: SEARCH_SOFT_CONFIRM,
      models: {
        searchBatch: stageModel('searchBatch'),
        searchRelevance: stageModel('searchRelevance'),
        searchSpec: stageModel('searchSpec'), // entendimento da consulta (busca precisão-primeiro)
        fallback: { model: MODELS.pro },
      },
      concurrency: { soft: SEARCH_WEB_SOFT_CONCURRENCY, deep: SEARCH_WEB_DEEP_CONCURRENCY },
      uiConcurrency: { default: SEARCH_UI_CONCURRENCY_DEFAULT, ceiling: SEARCH_UI_CONCURRENCY_CEILING },
      costHints,
    },
  };

  // Tags de todos os artigos numa query só, agrupadas no shape {faceta:[tags]} (= tagsOf do web.js).
  const tagsByArticle = new Map();
  for (const r of stmts.webExportTags.all()) {
    let m = tagsByArticle.get(r.article_id);
    if (!m) tagsByArticle.set(r.article_id, (m = {}));
    (m[r.facet] ||= []).push(r.tag);
  }
  const articles = stmts.webExportArticles.all().map((a) => ({
    ...a,
    // o substr do SQL não normaliza whitespace; espelha o snippet() da busca (search.js)
    snippet: String(a.snippet || '').replace(/\s+/g, ' ').trim(),
    tags: tagsByArticle.get(a.id) || {},
  }));

  // Chaves inteiras-string serializam em ordem numérica ASC no stringify (determinístico).
  const contents = {};
  for (const r of stmts.webExportContents.all()) contents[r.id] = r.content;

  return { meta, articles, contents };
}

/** Escreve meta/articles/contents.json em `outDir`. Retorna { articles, bytes }. */
export function exportWebSnapshot({ outDir }) {
  const { meta, articles, contents } = buildWebSnapshot();
  mkdirSync(outDir, { recursive: true });
  // Indent de 1: um campo por linha (diff de git legível); o gzip/brotli do deploy anula o custo.
  const files = [
    ['meta.json', meta],
    ['articles.json', articles],
    ['contents.json', contents],
  ];
  let bytes = 0;
  for (const [name, data] of files) {
    const json = JSON.stringify(data, null, 1) + '\n';
    writeFileSync(path.join(outDir, name), json);
    bytes += Buffer.byteLength(json);
  }
  log(
    `export web: ${articles.length} artigos → ${outDir} ` +
      `(meta/articles/contents.json, ${(bytes / 1024 / 1024).toFixed(2)} MB brutos)`,
  );
  return { articles: articles.length, bytes };
}
