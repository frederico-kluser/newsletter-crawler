// Buscador web local (`ncrawl web`): servidor node:http SEM dependências novas que serve a UI
// React zero-build (React UMD + htm.module.js direto de node_modules, padrão da TUI) e uma API
// JSON lendo o SQLite ao vivo. Todo o SQL fica nos stmts (db.js); aqui só validação/formatação.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { stmts } from './db.js';
import {
  WEB_PORT, WEB_HOST, HAS_LLM, setRuntimeKey, BUDGET_USD,
  SEARCH_MODE_A_CONFIRM, SEARCH_SOFT_CONFIRM, SEARCH_BATCH_SIZE, stageModel,
  SEARCH_UI_CONCURRENCY_DEFAULT, SEARCH_UI_CONCURRENCY_CEILING,
} from './config.js';
import { TOOL_CONTENT_TYPES, isToolByTags, getFacets } from './taxonomy.js';
import { parseDate, log, warn, errorLog } from './util.js';
import { searchWeb } from './search.js';
import { probeOpenRouterKey, upsertEnvVar } from './keys.js';
import { initGovernor, stopGovernor } from './governor.js';
import { beginRun, endRun, estimateStageCallUsd, getBudgetState } from './budget.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web-ui');

// Vendors resolvidos de node_modules (offline, sem CDN). react/* usa o truque do package.json
// (o "exports" do react não expõe ./umd/*); o htm nem expõe ./package.json — resolve pelo main.
const _require = createRequire(import.meta.url);
const pkgDir = (pkg) => path.dirname(_require.resolve(`${pkg}/package.json`));
const VENDOR = {
  'react.js': path.join(pkgDir('react'), 'umd', 'react.production.min.js'),
  'react-dom.js': path.join(pkgDir('react-dom'), 'umd', 'react-dom.production.min.js'),
  'htm.js': path.join(path.dirname(_require.resolve('htm')), 'htm.module.js'),
};
// Assets da UI: allowlist explícita (nada de servir caminho arbitrário do disco).
const ASSETS = { 'app.js': 'application/javascript', 'styles.css': 'text/css' };

const MAX_PAGE = 100;
const DEFAULT_PAGE = 24;

// ---- API ----

const asDateOnly = (raw) => {
  const d = parseDate(raw);
  return d ? d.toISOString().slice(0, 10) : null;
};

/** Traduz a querystring do BROWSE em params dos stmts web* (NULL = filtro desligado). {error} se inválida. */
function buildSearchParams(sp) {
  let sourceId = null;
  const sourceRaw = sp.get('source');
  if (sourceRaw) {
    sourceId = Number(sourceRaw);
    if (!Number.isInteger(sourceId) || sourceId <= 0) return { error: 'source deve ser um id numérico' };
  }

  let from = null;
  if (sp.get('from')) {
    from = asDateOnly(sp.get('from'));
    if (!from) return { error: 'from inválido (use YYYY-MM-DD)' };
  }
  let to = null;
  if (sp.get('to')) {
    to = asDateOnly(sp.get('to'));
    if (!to) return { error: 'to inválido (use YYYY-MM-DD)' };
  }

  let kind = null;
  const kindRaw = sp.get('kind');
  if (kindRaw) {
    if (!['news', 'tool', 'release'].includes(kindRaw)) return { error: 'kind deve ser news|tool|release' };
    kind = kindRaw;
  }

  let verify = null;
  const verifyRaw = sp.get('verify');
  if (verifyRaw) {
    if (!['ok', 'suspect', 'junk'].includes(verifyRaw)) return { error: 'verify deve ser ok|suspect|junk' };
    verify = verifyRaw;
  }

  // facets: objeto JSON {faceta:[tags]}; entradas vazias/não-string são descartadas.
  let facets = null;
  if (sp.get('facets')) {
    let parsed;
    try {
      parsed = JSON.parse(sp.get('facets'));
    } catch {
      return { error: 'facets deve ser um objeto JSON {faceta:[tags]}' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'facets deve ser um objeto JSON {faceta:[tags]}' };
    }
    const clean = {};
    for (const [facet, tags] of Object.entries(parsed)) {
      if (!Array.isArray(tags)) continue;
      const list = tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim());
      if (list.length) clean[facet] = list;
    }
    if (Object.keys(clean).length) facets = JSON.stringify(clean);
  }

  const limitRaw = Number(sp.get('limit') || DEFAULT_PAGE);
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_PAGE) : DEFAULT_PAGE;
  const offsetRaw = Number(sp.get('offset') || 0);
  const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

  return {
    params: {
      sourceId,
      from,
      to,
      kind,
      verify,
      facets,
      toolTypes: JSON.stringify([...TOOL_CONTENT_TYPES]),
    },
    limit,
    offset,
  };
}

const tagsOf = (articleId) => {
  const rows = stmts.getTagsForArticle.all(articleId);
  const byFacet = {};
  for (const r of rows) (byFacet[r.facet] ||= []).push(r.tag);
  return { rows, byFacet };
};

function apiArticles(sp) {
  const r = buildSearchParams(sp);
  if (r.error) return { status: 400, body: { error: r.error } };
  const total = stmts.webCountArticles.get(r.params).c;
  const items = stmts.webSearchArticles.all({ ...r.params, limit: r.limit, offset: r.offset }).map((a) => {
    const { rows, byFacet } = tagsOf(a.id);
    return { ...a, tags: byFacet, kind: a.kind || (isToolByTags(rows) ? 'tool' : 'news') };
  });
  return { status: 200, body: { total, limit: r.limit, offset: r.offset, items } };
}

function apiArticle(id) {
  const a = stmts.webGetArticle.get(id);
  if (!a) return { status: 404, body: { error: 'artigo não encontrado' } };
  const { rows, byFacet } = tagsOf(a.id);
  return { status: 200, body: { ...a, tags: byFacet, kind: a.kind || (isToolByTags(rows) ? 'tool' : 'news') } };
}

function apiMeta() {
  const tagRows = stmts.webMetaTags.all();
  const grouped = new Map();
  for (const r of tagRows) {
    if (!grouped.has(r.facet)) grouped.set(r.facet, []);
    grouped.get(r.facet).push({ tag: r.tag, count: r.c });
  }
  // Ordena as facetas pela ordem canônica da taxonomia; fail-open p/ a ordem do banco
  // (getFacets lê taxonomy.json e LANÇA se ausente — a UI não pode cair por isso).
  let order = [...grouped.keys()];
  try {
    const canonical = getFacets().map((f) => f.name);
    order = [...canonical.filter((n) => grouped.has(n)), ...order.filter((n) => !canonical.includes(n))];
  } catch {
    /* mantém a ordem do banco */
  }
  const dates = stmts.webMetaDates.get();
  // Custo de IA: acumulado (todas as runs) + última execução — o buscador é pós-crawl, então
  // "tempo real" aqui é o gasto consolidado da coleta que gerou o acervo.
  const usage = stmts.sumUsageTotal.get();
  const lastRun = stmts.getLastRun.get();
  return {
    status: 200,
    body: {
      totals: {
        articles: stmts.countArticles.get().c,
        summaries: stmts.countSummaries.get().c,
        classified: stmts.countClassifications.get().c,
      },
      cost: {
        totalUsd: usage.usd,
        totalCalls: usage.n,
        lastRun: lastRun
          ? { id: lastRun.id, spentUsd: lastRun.spent_usd, budgetUsd: lastRun.budget_usd, status: lastRun.status }
          : null,
      },
      sources: stmts.webMetaSources.all().map((s) => ({ id: s.id, name: s.name || s.base_url, count: s.c })),
      facets: order.map((name) => ({ name, tags: grouped.get(name) })),
      dates: { min: dates.min_d, max: dates.max_d },
      // limites do slider de paralelismo da busca (o servidor CLAMPA o valor recebido a [1, ceiling])
      search: { concurrency: { default: SEARCH_UI_CONCURRENCY_DEFAULT, ceiling: SEARCH_UI_CONCURRENCY_CEILING } },
    },
  };
}

// ---- busca IA (soft em lote / hard por artigo) + key ----

const MAX_SCOPE_SOURCES = 50;
const MAX_BODY_BYTES = 64 * 1024;

/** Paralelismo pedido pela UI → inteiro em [1, ceiling]; fora disso/ausente → default. */
function clampConcurrency(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return SEARCH_UI_CONCURRENCY_DEFAULT;
  return Math.min(n, SEARCH_UI_CONCURRENCY_CEILING);
}

/**
 * Valida o ESCOPO da busca IA {sources, from, to} (querystring do preflight OU body do POST).
 * sources: array de ids inteiros > 0 (máx. 50) ou null. Datas YYYY-MM-DD. {error} PT se inválido.
 */
function buildScopeParams({ sources, from, to }) {
  let list = null;
  if (sources != null && sources !== '') {
    let arr = sources;
    if (typeof arr === 'string') {
      try {
        arr = JSON.parse(arr);
      } catch {
        return { error: 'sources deve ser um array JSON de ids' };
      }
    }
    if (!Array.isArray(arr)) return { error: 'sources deve ser um array JSON de ids' };
    if (arr.length > MAX_SCOPE_SOURCES) return { error: `sources demais (máx. ${MAX_SCOPE_SOURCES})` };
    const ids = [];
    for (const v of arr) {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) return { error: 'sources deve conter ids numéricos' };
      ids.push(n);
    }
    if (ids.length) list = ids;
  }
  let fromD = null;
  if (from) {
    fromD = asDateOnly(from);
    if (!fromD) return { error: 'from inválido (use YYYY-MM-DD)' };
  }
  let toD = null;
  if (to) {
    toD = asDateOnly(to);
    if (!toD) return { error: 'to inválido (use YYYY-MM-DD)' };
  }
  return {
    sources: list,
    params: { sources: list ? JSON.stringify(list) : null, from: fromD, to: toD },
  };
}

/** Lê e parseia o body JSON de um POST. Resolve {body} ou {error, status} (413/400); nunca rejeita. */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (tooBig) return;
      if (size > MAX_BODY_BYTES) {
        tooBig = true; // não acumula mais; responde 413 no end (sem destruir o socket)
        chunks.length = 0;
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      if (tooBig) return resolve({ error: 'corpo grande demais', status: 413 });
      try {
        resolve({ body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
      } catch {
        resolve({ error: 'JSON inválido no corpo', status: 400 });
      }
    });
    req.on('error', () => resolve({ error: 'falha ao ler o corpo', status: 400 }));
  });
}

// UMA busca IA por vez neste processo: o run do ledger (budget.js beginRun/endRun) é um global
// por processo, então buscas concorrentes se atropelariam — a 2ª leva 409.
let _searchBusy = false;

/**
 * Mini-envelope do servidor (não dá p/ reusar runWithLimits: ciclo de import com commands.js e
 * process.exit nas validações de lá). Governador em perfil llm-only (concorrência plena da lane
 * llm p/ o modo por-artigo) + run próprio no ledger (custo real em runs/llm_usage).
 */
async function withSearchRun(args, fn) {
  initGovernor({ profile: 'llm-only' });
  beginRun({ command: 'web-search', budgetUsd: BUDGET_USD, args });
  let failed = false;
  try {
    return await fn();
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    endRun(failed ? 'failed' : undefined);
    stopGovernor();
  }
}

/** Preflight do custo/escopo: contagem + estimativa US$ p/ o diálogo de confirmação do cliente. */
function apiSearchScope(sp) {
  const scope = buildScopeParams({ sources: sp.get('sources'), from: sp.get('from'), to: sp.get('to') });
  if (scope.error) return { status: 400, body: { error: scope.error } };
  const deep = sp.get('deep') === '1' || sp.get('deep') === 'true';
  const count = stmts.webSearchScopeCount.get(scope.params).c;
  const stage = deep ? 'searchRelevance' : 'searchBatch';
  const judgeCalls = deep ? count : Math.ceil(count / SEARCH_BATCH_SIZE);
  // +1 chamada de "entendimento da consulta" (searchSpec, Pro) por busca — amortizada, mas conta no custo.
  const specUsd = count > 0 ? estimateStageCallUsd('searchSpec', stageModel('searchSpec').model) : 0;
  const calls = judgeCalls + (count > 0 ? 1 : 0);
  const estimatedUsd = judgeCalls * estimateStageCallUsd(stage, stageModel(stage).model) + specUsd;
  const threshold = deep ? SEARCH_MODE_A_CONFIRM : SEARCH_SOFT_CONFIRM;
  return {
    status: 200,
    body: { count, calls, estimatedUsd, threshold, needsConfirm: count > threshold, hasKey: HAS_LLM },
  };
}

/** POST /api/search {query, deep, sources, from, to, confirm} — a resposta demora o que a IA demorar. */
async function apiSearch(req, res, deps) {
  const parsed = await readJsonBody(req);
  if (parsed.error) return sendJSON(res, parsed.status, { error: parsed.error });
  const body = parsed.body || {};
  const query = String(body.query || '').trim().slice(0, 500);
  if (!query) return sendJSON(res, 400, { error: 'informe uma consulta' });
  if (!HAS_LLM) {
    return sendJSON(res, 400, {
      error: 'OPENROUTER_API_KEY ausente — configure a chave para buscar com IA.',
      code: 'NO_KEY',
    });
  }
  const deep = body.deep === true;
  const scope = buildScopeParams(body);
  if (scope.error) return sendJSON(res, 400, { error: scope.error });
  const count = stmts.webSearchScopeCount.get(scope.params).c;
  if (count === 0) {
    return sendJSON(res, 200, {
      query, deep, scanned: 0, total: 0, relevant: 0, skipped: 0, truncated: false, items: [],
    });
  }
  // Guard re-validado no SERVIDOR (o diálogo do cliente vem do preflight /api/search/scope).
  const threshold = deep ? SEARCH_MODE_A_CONFIRM : SEARCH_SOFT_CONFIRM;
  if (count > threshold && body.confirm !== true) {
    return sendJSON(res, 428, { error: `escopo com ${count} artigos exige confirmação`, needsConfirm: true, count });
  }
  if (_searchBusy) {
    return sendJSON(res, 409, { error: 'Já existe uma busca em andamento — aguarde terminar.' });
  }
  const concurrency = clampConcurrency(body.concurrency);
  _searchBusy = true;
  try {
    const r = await withSearchRun({ query, deep, ...scope.params }, () =>
      deps.search(query, { deep, sources: scope.sources, from: scope.params.from, to: scope.params.to, concurrency }),
    );
    // Enriquecimento p/ os cards: re-select por ids + a MESMA decoração de tags/kind do browse.
    const rows = r.hits.length
      ? stmts.webArticlesByIds.all({ ids: JSON.stringify(r.hits.map((h) => h.id)) })
      : [];
    const byId = new Map(rows.map((a) => [a.id, a]));
    const items = [];
    for (const h of r.hits) {
      const a = byId.get(h.id);
      if (!a) continue; // artigo sumiu entre a varredura e o select (purge concorrente)
      const { rows: tagRows, byFacet } = tagsOf(a.id);
      items.push({
        ...a,
        tags: byFacet,
        kind: a.kind || (isToolByTags(tagRows) ? 'tool' : 'news'),
        relation: h.relation,
        judge_kind: h.kind,
      });
    }
    const { hits: _drop, ...rest } = r;
    return sendJSON(res, 200, { ...rest, items });
  } catch (e) {
    errorLog(`web /api/search: ${e.message}`);
    return sendJSON(res, 500, { error: 'a busca falhou — veja o terminal do servidor' });
  } finally {
    _searchBusy = false;
  }
}

/** Enriquece 1 hit CRU {id,relation,kind} no card do browse (mesma decoração do apiSearch). */
function enrichHit(h) {
  const a = stmts.webArticlesByIds.all({ ids: JSON.stringify([h.id]) })[0];
  if (!a) return null;
  const { rows: tagRows, byFacet } = tagsOf(a.id);
  return {
    ...a,
    tags: byFacet,
    kind: a.kind || (isToolByTags(tagRows) ? 'tool' : 'news'),
    relation: h.relation,
    judge_kind: h.kind,
  };
}

// ---- histórico de buscas (tabela `searches`; escrito por searchWeb/runSearch ao concluir) ----

const parseJsonCol = (s) => {
  try {
    return JSON.parse(s || 'null');
  } catch {
    return null;
  }
};

/** GET /api/searches — lista leve (sem hits): consulta, modo, escopo, stats e custo real. */
function apiSearches() {
  const searches = stmts.listSearches.all().map((s) => ({
    id: s.id,
    created_at: s.created_at,
    origin: s.origin,
    query: s.query,
    mode: s.mode,
    scope: parseJsonCol(s.scope_json) || {},
    stats: parseJsonCol(s.stats_json) || {},
    spent_usd: s.spent_usd || 0,
  }));
  return { status: 200, body: { searches } };
}

/**
 * GET /api/searches/:id — a busca CONGELADA re-hidratada em cards (mesmo shape do POST
 * /api/search), SEM tocar LLM. Id de artigo que sumiu (purge) vira `missing`, nunca 500.
 */
function apiSearchDetail(id) {
  const s = stmts.getSearch.get(id);
  if (!s) return { status: 404, body: { error: 'busca não encontrada' } };
  const hits = parseJsonCol(s.hits_json) || [];
  const items = [];
  let missing = 0;
  for (const h of hits) {
    const card = enrichHit(h);
    if (card) items.push(card);
    else missing++;
  }
  const stats = parseJsonCol(s.stats_json) || {};
  return {
    status: 200,
    body: {
      id: s.id,
      created_at: s.created_at,
      origin: s.origin,
      query: s.query,
      mode: s.mode,
      deep: s.mode === 'deep',
      scope: parseJsonCol(s.scope_json) || {},
      spentUsd: s.spent_usd || 0,
      scanned: stats.scanned ?? null,
      total: stats.total ?? null,
      relevant: items.length,
      failed: stats.failed || 0,
      skipped: stats.skipped || 0,
      truncated: !!stats.truncated,
      missing,
      items,
    },
  };
}

/**
 * GET /api/search/stream?q=&deep=&sources=&from=&to=&confirm= — a MESMA busca do POST /api/search,
 * mas em STREAMING (SSE): eventos `progress` (scanned/total/relevant/failed/spentUsd), `hit` (card
 * enriquecido, AO VIVO) e `done` (resumo final). EventSource é GET-only → params na querystring.
 * Guards idênticos ao POST: 400 sem query/sem key, 428 sem confirm, 409 se já há busca rodando. A
 * busca roda até o fim (o governador cuida da concorrência adaptativa); se o cliente cai, paramos
 * de escrever (`open=false`) e liberamos o lock no finally.
 */
async function apiSearchStream(req, res, deps, u) {
  const sp = u.searchParams;
  const query = String(sp.get('q') || '').trim().slice(0, 500);
  if (!query) return sendJSON(res, 400, { error: 'informe uma consulta' });
  if (!HAS_LLM) {
    return sendJSON(res, 400, { error: 'OPENROUTER_API_KEY ausente — configure a chave para buscar com IA.', code: 'NO_KEY' });
  }
  const deep = sp.get('deep') === '1' || sp.get('deep') === 'true';
  const concurrency = clampConcurrency(sp.get('concurrency'));
  const scope = buildScopeParams({ sources: sp.get('sources'), from: sp.get('from'), to: sp.get('to') });
  if (scope.error) return sendJSON(res, 400, { error: scope.error });
  const count = stmts.webSearchScopeCount.get(scope.params).c;
  const threshold = deep ? SEARCH_MODE_A_CONFIRM : SEARCH_SOFT_CONFIRM;
  const confirm = sp.get('confirm') === '1' || sp.get('confirm') === 'true';
  if (count > threshold && !confirm) {
    return sendJSON(res, 428, { error: `escopo com ${count} artigos exige confirmação`, needsConfirm: true, count });
  }
  if (_searchBusy) {
    return sendJSON(res, 409, { error: 'Já existe uma busca em andamento — aguarde terminar.' });
  }
  _searchBusy = true;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // não bufferizar atrás de proxies
  });
  let open = true;
  const send = (event, data) => {
    if (!open) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      open = false;
    }
  };
  req.on('close', () => {
    open = false;
  });
  res.write(': stream aberto\n\n'); // comentário SSE: dispara o onopen do cliente já
  if (count === 0) {
    send('done', { query, deep, scanned: 0, total: 0, relevant: 0, failed: 0, skipped: 0, truncated: false });
    _searchBusy = false;
    return res.end();
  }
  let lastSpent = 0;
  try {
    const r = await withSearchRun({ query, deep, ...scope.params }, () =>
      deps.search(query, {
        deep,
        sources: scope.sources,
        from: scope.params.from,
        to: scope.params.to,
        concurrency,
        onEvent: (ev) => {
          if (!open) return;
          if (ev.type === 'hit') {
            const item = enrichHit(ev.hit);
            if (item) send('hit', item);
          } else if (ev.type === 'progress') {
            lastSpent = getBudgetState().spentUsd;
            send('progress', { ...ev, spentUsd: lastSpent });
          } else if (ev.type === 'spec') {
            send('spec', ev.spec); // o "entendimento" da consulta chega antes dos hits (banner)
          }
        },
      }),
    );
    const { hits: _drop, ...rest } = r;
    send('done', { ...rest, spentUsd: lastSpent });
  } catch (e) {
    errorLog(`web /api/search/stream: ${e.message}`);
    send('error', { error: 'a busca falhou — veja o terminal do servidor' });
  } finally {
    _searchBusy = false;
    open = false;
    res.end();
  }
}

/** POST /api/key {key}: valida no OpenRouter (probe) e só então persiste + ativa em runtime. */
async function apiKeySet(req, res, deps) {
  const parsed = await readJsonBody(req);
  if (parsed.error) return sendJSON(res, parsed.status, { error: parsed.error });
  const key = String(parsed.body?.key || '').trim();
  if (!key) return sendJSON(res, 400, { error: 'informe a chave' });
  const r = await deps.probeKey(key);
  if (!r.ok) return sendJSON(res, 200, { ok: false, status: r.status, reason: r.reason || null });
  upsertEnvVar('OPENROUTER_API_KEY', key); // persiste (NC_HOME/.env), igual `ncrawl key set`
  setRuntimeKey(key); // live binding: HAS_LLM/client() enxergam a key nova sem reiniciar
  return sendJSON(res, 200, { ok: true });
}

// ---- servidor ----

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendFile(res, file, type, cache = 'no-store') {
  // Lê a cada request (arquivos pequenos, edição ao vivo em dev); ENOENT vira 500 no handler.
  const body = readFileSync(file);
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
  res.end(body);
}

async function handleRequest(req, res, deps) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
      return sendJSON(res, 405, { error: 'somente GET/POST/DELETE' });
    }
    if (req.method === 'POST') {
      // POST só nas rotas de AÇÃO (busca IA e key); todo o resto é GET.
      if (p === '/api/search') return await apiSearch(req, res, deps);
      if (p === '/api/key') return await apiKeySet(req, res, deps);
      return sendJSON(res, 405, { error: 'somente GET nesta rota' });
    }
    if (req.method === 'DELETE') {
      // DELETE só no histórico de buscas (item ou tudo).
      if (p === '/api/searches') {
        return sendJSON(res, 200, { deleted: stmts.clearSearches.run().changes });
      }
      const dm = p.match(/^\/api\/searches\/(\d+)$/);
      if (dm) {
        const n = stmts.deleteSearch.run(Number(dm[1])).changes;
        return n
          ? sendJSON(res, 200, { deleted: 1 })
          : sendJSON(res, 404, { error: 'busca não encontrada' });
      }
      return sendJSON(res, 405, { error: 'DELETE só no histórico de buscas' });
    }
    if (p === '/' || p === '/index.html') {
      return sendFile(res, path.join(UI_DIR, 'index.html'), 'text/html; charset=utf-8');
    }
    if (p.startsWith('/assets/')) {
      const name = p.slice('/assets/'.length);
      if (ASSETS[name]) return sendFile(res, path.join(UI_DIR, name), `${ASSETS[name]}; charset=utf-8`);
      return sendJSON(res, 404, { error: 'asset desconhecido' });
    }
    if (p.startsWith('/vendor/')) {
      const name = p.slice('/vendor/'.length);
      if (VENDOR[name]) return sendFile(res, VENDOR[name], 'application/javascript; charset=utf-8', 'public, max-age=86400');
      return sendJSON(res, 404, { error: 'vendor desconhecido' });
    }
    if (p === '/api/meta') {
      const r = apiMeta();
      return sendJSON(res, r.status, r.body);
    }
    if (p === '/api/articles') {
      const r = apiArticles(u.searchParams);
      return sendJSON(res, r.status, r.body);
    }
    if (p === '/api/search/stream') return await apiSearchStream(req, res, deps, u);
    if (p === '/api/search/scope') {
      const r = apiSearchScope(u.searchParams);
      return sendJSON(res, r.status, r.body);
    }
    if (p === '/api/searches') {
      const r = apiSearches();
      return sendJSON(res, r.status, r.body);
    }
    const sm = p.match(/^\/api\/searches\/(\d+)$/);
    if (sm) {
      const r = apiSearchDetail(Number(sm[1]));
      return sendJSON(res, r.status, r.body);
    }
    if (p === '/api/key/status') {
      return sendJSON(res, 200, { hasKey: HAS_LLM });
    }
    const m = p.match(/^\/api\/article\/(\d+)$/);
    if (m) {
      const r = apiArticle(Number(m[1]));
      return sendJSON(res, r.status, r.body);
    }
    return sendJSON(res, 404, { error: 'não encontrado' });
  } catch (e) {
    errorLog(`web ${req.method} ${p}: ${e.message}`);
    return sendJSON(res, 500, { error: 'erro interno' });
  }
}

/** Abre a URL no navegador padrão (best-effort: falha vira warn, nunca derruba o servidor). */
export function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', (e) => warn(`não consegui abrir o navegador (${e.message}) — acesse ${url}`));
    child.unref();
  } catch (e) {
    warn(`não consegui abrir o navegador (${e.message}) — acesse ${url}`);
  }
}

/**
 * Sobe o servidor do buscador. `port: 0` = porta efêmera (testes). Retorna { server, port, url,
 * close() } — o chamador (CLI/TUI) é dono do ciclo de vida; close() é await-ável.
 * `deps` injeta o motor de busca/probe de key (testes trocam por fakes sem rede/LLM).
 */
export function startWebServer({ port = WEB_PORT, host = WEB_HOST, open = false, deps = {} } = {}) {
  const d = { search: searchWeb, probeKey: probeOpenRouterKey, ...deps };
  return new Promise((resolve, reject) => {
    // A busca IA responde MINUTOS depois do request. Isso é seguro nos defaults do Node: o body
    // do POST é consumido ANTES do trabalho (request "completo"), e o requestTimeout (5 min)
    // só vale p/ requests INCOMPLETOS; keepAliveTimeout conta só ENTRE requests.
    const server = http.createServer((req, res) => {
      handleRequest(req, res, d).catch((e) => {
        errorLog(`web ${req.method} ${req.url}: ${e.message}`);
        if (!res.headersSent) sendJSON(res, 500, { error: 'erro interno' });
      });
    });
    server.once('error', reject); // ex.: EADDRINUSE antes do listen completar
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
      const url = `http://${shownHost}:${actualPort}`;
      log(`buscador web no ar: ${url}`);
      if (open) openBrowser(url);
      resolve({
        server,
        port: actualPort,
        url,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
