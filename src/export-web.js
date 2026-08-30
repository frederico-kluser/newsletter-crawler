// Snapshot JSON estático do acervo p/ o webapp (`ncrawl export --format web`), em webapp/public/
// data — meta.json (totais/fontes/facetas/config da busca IA + contentsParts; ÚNICO com campo
// volátil, generatedAt), articles.json (campos de browse SEM content, id ASC) e contents.partN.json
// (map id→content de CADA parte; o cliente baixa só a parte que contém um id, ao abrir um preview
// ou rodar busca profunda). O contents ÚNICO (contents.json) passou de 100 MB no acervo cheio e o
// GitHub rejeita blobs > 100 MB (GH001) — por isso o mapa é FATIADO em partes determinísticas por
// id ASC, com peso acumulado de bytes até um alvo (EXPORT_WEB_PART_MB, default 85), e o arquivo
// antigo é SEMPRE removido do outDir (nunca pode sobrar p/ o deploy o commitá-lo de novo).
// Determinístico de propósito: toda ordenação vem do SQL, o stringify é estável e a estimativa de
// bytes jamais subestima — re-exportar sem mudança na base gera bytes idênticos em articles/partes
// (diffs de git legíveis).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stmts } from './db.js';
import {
  MODELS, SEARCH_BATCH_SIZE, SEARCH_MAX_CHARS, SEARCH_WEB_MAX_ITEMS,
  SEARCH_MODE_A_CONFIRM, SEARCH_SOFT_CONFIRM, stageModel, translateModel,
  SEARCH_WEB_SOFT_CONCURRENCY, SEARCH_WEB_DEEP_CONCURRENCY,
  SEARCH_UI_CONCURRENCY_DEFAULT, SEARCH_UI_CONCURRENCY_CEILING,
  TTS_MODEL, TTS_VOICE, TTS_FORMAT, EXPORT_WEB_PART_MB,
} from './config.js';
import { getFacets, TOOL_CONTENT_TYPES } from './taxonomy.js';
import { redactSecrets } from './redact.js';
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

// ---- contents em partes (map id→content fatiado; o arquivo único passou de 100 MB) ----

// Teto DURO de uma parte (MB). Um artigo isolado pode estourar o ALVO e vai sozinho numa parte,
// mas acima disto o export FALHA (fail-closed): uma parte com um único artigo gigante repetiria o
// bloqueio GH001 do GitHub (blobs > 100 MB rejeitados no push). Alvo default 85 deixa folga de 10.
const PART_HARD_CAP_MB = 95;

// Custo serializado de ` "key": <json>` numa parte (indent 1): indent+newline (2) + aspas do key
// (key.length+2) + ": " (2) + corpo JSON-escapeado + vírgula/fecha (1). O JSON.stringify escapeia
// aspas/controles/`\` (nunca encolhe), então a estimativa NUNCA subestima o byte final — a parte
// real fica sempre <= alvo quando o corte é por esta estimativa (a única exceção é um artigo
// isolado maior que o alvo: ele vai sozinho numa parte, ainda <= teto duro — acima do teto duro o
// export LANÇA erro, fail-closed, nunca uma parte > teto).
function entryBytes(key, body) {
  return 2 + key.length + 2 + 2 + Buffer.byteLength(JSON.stringify(body)) + 1;
}

function partTargetBytes(partMb) {
  const mb = Number(partMb);
  const safe = Number.isFinite(mb) && mb > 0 ? mb : EXPORT_WEB_PART_MB;
  return Math.floor(safe * 1024 * 1024);
}

/** Monta os objetos do snapshot (puro sobre stmts; o writer fica em exportWebSnapshot). */
export function buildWebSnapshot({ partMb } = {}) {
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
        // MODELS.pro guarda o slug OpenRouter; o export reflete o que o runtime usa de fato
        // (translateModel é identidade no openrouter, direto na DeepSeek).
        fallback: { model: translateModel(MODELS.pro) },
      },
      concurrency: { soft: SEARCH_WEB_SOFT_CONCURRENCY, deep: SEARCH_WEB_DEEP_CONCURRENCY },
      uiConcurrency: { default: SEARCH_UI_CONCURRENCY_DEFAULT, ceiling: SEARCH_UI_CONCURRENCY_CEILING },
      costHints,
    },
    // Play de áudio (TTS): modelo/voz que o webapp usa ao narrar summary_pt direto do browser
    // (BYOK). Re-export troca a voz sem deploy de código; o webapp tem fallback próprio.
    audio: { model: TTS_MODEL, voice: TTS_VOICE, format: TTS_FORMAT },
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
    title: redactSecrets(a.title),
    snippet: redactSecrets(String(a.snippet || '').replace(/\s+/g, ' ').trim()),
    tags: tagsByArticle.get(a.id) || {},
  }));

  // ---- contents em PARTES: particiona por id ASC acumulando o peso estimado de bytes ----
  // Cada parte vira contents.partN.json com o map id→content daquele corte e o meta ganha
  // contentsParts [{file, from, to}] p/ o cliente localizar a parte de um id (sem baixar tudo).
  // Determinístico: a ordem vem do ORDER BY id do stmts e o peso só depende dos bytes dos corpos.
  const targetBytes = partTargetBytes(partMb);
  const hardCapBytes = PART_HARD_CAP_MB * 1024 * 1024;
  const contentsParts = [];
  let cur = null;
  for (const r of stmts.webExportContents.all()) {
    const key = String(r.id);
    // Corpos passam pela redação de segredos: um artigo pode carregar um token no texto e o GitHub
    // Push Protection rejeitaria o push do snapshot inteiro (ver src/redact.js).
    const body = redactSecrets(r.content);
    const cost = entryBytes(key, body);
    // Fail-closed: um artigo isolado acima do TETO DURO vira uma parte > 100 MB e o GitHub
    // rejeitaria o push (GH001) — o export não pode produzir isso nem com aviso, lança erro.
    if (cost > hardCapBytes) {
      throw new Error(
        `export web: artigo ${r.id} tem ~${(cost / 1024 / 1024).toFixed(1)} MB sozinho — ` +
          `acima do teto duro de ${PART_HARD_CAP_MB} MB por parte; o GitHub rejeitaria o push (GH001).`,
      );
    }
    // Fecha a parte atual quando a próxima entrada estouraria o alvo (a parte já tem >= 1 entrada;
    // um artigo isolado entre o alvo e o teto duro vai sozinho — excede o alvo mas fica <= teto).
    if (cur && cur.bytes + cost > targetBytes) cur = null;
    if (!cur) {
      cur = { file: `contents.part${contentsParts.length}.json`, from: r.id, to: r.id, map: {}, bytes: 2 };
      contentsParts.push(cur);
    }
    cur.map[key] = body;
    cur.bytes += cost;
    if (r.id < cur.from) cur.from = r.id;
    if (r.id > cur.to) cur.to = r.id;
  }

  // o cliente localiza a parte de um id por from..to, sem baixar as outras.
  meta.contentsParts = contentsParts.map(({ file, from, to }) => ({ file, from, to }));

  return { meta, articles, contentsParts };
}

/** Escreve meta/articles.json/contents.partN.json em `outDir`. Retorna { articles, bytes, parts }. */
export function exportWebSnapshot({ outDir, partMb } = {}) {
  const { meta, articles, contentsParts } = buildWebSnapshot({ partMb });
  mkdirSync(outDir, { recursive: true });
  // O contents.json ÚNICO (90-100+ MB no acervo cheio) NUNCA pode sobrar: se o export o
  // regenerasse, o hook/deploy o commitariam e o GitHub rejeitaria o push (GH001, > 100 MB).
  // Remove qualquer resíduo (inclusive o rastreado: o diff vira remoção e sai do repo no commit).
  rmSync(path.join(outDir, 'contents.json'), { force: true });
  // Indent de 1: um campo por linha (diff de git legível); o gzip/brotli do deploy anula o custo.
  const files = [
    ['meta.json', meta],
    ['articles.json', articles],
    ...contentsParts.map((p) => [p.file, p.map]),
  ];
  let bytes = 0;
  for (const [name, data] of files) {
    const json = JSON.stringify(data, null, 1) + '\n';
    writeFileSync(path.join(outDir, name), json);
    bytes += Buffer.byteLength(json);
  }
  const parts = contentsParts.map(({ file, from, to }) => ({ file, from, to }));
  const contentsLabel = parts.length
    ? `contents.part0.json${parts.length > 1 ? `…part${parts.length - 1}.json` : ''}`
    : 'contents (0 partes)';
  log(
    `export web: ${articles.length} artigos → ${outDir} ` +
      `(meta/articles.json/${contentsLabel}, ${(bytes / 1024 / 1024).toFixed(2)} MB brutos)`,
  );
  return { articles: articles.length, bytes, parts };
}
