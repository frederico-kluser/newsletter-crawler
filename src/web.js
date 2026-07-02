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
import { WEB_PORT, WEB_HOST } from './config.js';
import { TOOL_CONTENT_TYPES, isToolByTags, getFacets } from './taxonomy.js';
import { foldText, parseDate, log, warn, errorLog } from './util.js';

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

/** Traduz a querystring em params dos stmts web* (NULL = filtro desligado). {error} se inválida. */
function buildSearchParams(sp) {
  const q = (sp.get('q') || '').trim();

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
    if (kindRaw !== 'news' && kindRaw !== 'tool') return { error: 'kind deve ser news|tool' };
    kind = kindRaw;
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
      q: q ? foldText(q) : null,
      sourceId,
      from,
      to,
      kind,
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
    return { ...a, tags: byFacet, kind: isToolByTags(rows) ? 'tool' : 'news' };
  });
  return { status: 200, body: { total, limit: r.limit, offset: r.offset, items } };
}

function apiArticle(id) {
  const a = stmts.webGetArticle.get(id);
  if (!a) return { status: 404, body: { error: 'artigo não encontrado' } };
  const { rows, byFacet } = tagsOf(a.id);
  return { status: 200, body: { ...a, tags: byFacet, kind: isToolByTags(rows) ? 'tool' : 'news' } };
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
  return {
    status: 200,
    body: {
      totals: {
        articles: stmts.countArticles.get().c,
        summaries: stmts.countSummaries.get().c,
        classified: stmts.countClassifications.get().c,
      },
      sources: stmts.webMetaSources.all().map((s) => ({ id: s.id, name: s.name || s.base_url, count: s.c })),
      facets: order.map((name) => ({ name, tags: grouped.get(name) })),
      dates: { min: dates.min_d, max: dates.max_d },
    },
  };
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

function handleRequest(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    if (req.method !== 'GET') return sendJSON(res, 405, { error: 'somente GET' });
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
 */
export function startWebServer({ port = WEB_PORT, host = WEB_HOST, open = false } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handleRequest);
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
