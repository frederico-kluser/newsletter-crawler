// Busca de HTML: estático (got), renderizado (Playwright), e decisão automática (fetchSmart).
import got from 'got';
import { chromium } from 'playwright';
import robotsParser from 'robots-parser';
import pLimit from 'p-limit';
import * as cheerio from 'cheerio';
import { USER_AGENT, REQUEST_DELAY_MS, PER_HOST_CONCURRENCY, MAX_RETRIES } from './config.js';
import { hostOf, jitterDelay, log, warn } from './util.js';

// ---- concorrência e circuit breaker por host ----
const hostLimiters = new Map();
function hostLimit(host) {
  if (!hostLimiters.has(host)) hostLimiters.set(host, pLimit(PER_HOST_CONCURRENCY));
  return hostLimiters.get(host);
}

const hostErrors = new Map();
const BREAK_THRESHOLD = 5;
const recordError = (h) => hostErrors.set(h, (hostErrors.get(h) || 0) + 1);
const recordOk = (h) => hostErrors.set(h, 0);
const isBroken = (h) => (hostErrors.get(h) || 0) >= BREAK_THRESHOLD;

// ---- robots.txt ----
const robotsCache = new Map();
export async function checkRobots(url) {
  try {
    const u = new URL(url);
    const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
    let robots = robotsCache.get(robotsUrl);
    if (!robots) {
      let txt = '';
      try {
        txt = await got(robotsUrl, {
          headers: { 'user-agent': USER_AGENT },
          timeout: { request: 10000 },
          retry: { limit: 1 },
        }).text();
      } catch {
        txt = '';
      }
      robots = robotsParser(robotsUrl, txt);
      robotsCache.set(robotsUrl, robots);
    }
    const allowed = robots.isAllowed(url, USER_AGENT);
    const cd = robots.getCrawlDelay(USER_AGENT);
    return { allowed: allowed !== false, crawlDelay: cd ? cd * 1000 : 0 };
  } catch {
    return { allowed: true, crawlDelay: 0 };
  }
}

// ---- fetch estático ----
export async function fetchStatic(url) {
  const host = hostOf(url);
  return hostLimit(host)(async () => {
    await jitterDelay(REQUEST_DELAY_MS);
    try {
      const res = await got(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
        timeout: { request: 20000 },
        retry: { limit: MAX_RETRIES, methods: ['GET'], statusCodes: [408, 429, 500, 502, 503, 504] },
        followRedirect: true,
      });
      recordOk(host);
      return { html: res.body, status: res.statusCode, url: res.url, rendered: false };
    } catch (e) {
      recordError(host);
      throw e;
    }
  });
}

// ---- fetch renderizado (Playwright, browser compartilhado) ----
// Em containers/CI o chromium aborta sem `--no-sandbox` (e o abort é um fatal de V8 que
// derruba o processo Node inteiro, não uma exceção capturável). Por isso os args abaixo são
// o default; sobrescreva com CRAWLER_CHROMIUM_ARGS (lista separada por vírgula) se precisar.
const CHROMIUM_ARGS = (process.env.CRAWLER_CHROMIUM_ARGS
  ? process.env.CRAWLER_CHROMIUM_ARGS.split(',')
  : ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'])
  .map((s) => s.trim())
  .filter(Boolean);

let _browser = null;
async function getBrowser() {
  if (!_browser) _browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  return _browser;
}
export async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

export async function fetchRendered(url) {
  const host = hostOf(url);
  return hostLimit(host)(async () => {
    await jitterDelay(REQUEST_DELAY_MS);
    const browser = await getBrowser();
    // ignoreHTTPSErrors: alguns veículos têm cert com CN inválido (ex.: kedglobal.com ->
    // ERR_CERT_COMMON_NAME_INVALID). Para crawler de artigos públicos, seguir mesmo assim.
    const ctx = await browser.newContext({ userAgent: USER_AGENT, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    try {
      await page.route('**/*', (route) => {
        const t = route.request().resourceType();
        return ['image', 'media', 'font'].includes(t) ? route.abort() : route.continue();
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await autoScroll(page);
      await clickLoadMore(page);
      const html = await page.content();
      const visibleText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      recordOk(host);
      return { html, visibleText, status: 200, url: page.url(), rendered: true };
    } catch (e) {
      recordError(host);
      throw e;
    } finally {
      await ctx.close().catch(() => {});
    }
  });
}

/** Rola até a altura parar de crescer (detecta fim de scroll infinito). */
export async function autoScroll(page, { step = 1200, pause = 800, maxRounds = 60 } = {}) {
  let prev = 0;
  for (let i = 0; i < maxRounds; i++) {
    const h = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
    if (!h || h === prev) break;
    prev = h;
    await page.evaluate((s) => window.scrollBy(0, s), step).catch(() => {});
    await page.waitForTimeout(pause);
  }
}

/** Clica repetidamente em botões "carregar mais / mais antigos / próximo". */
export async function clickLoadMore(
  page,
  label = /mais|more|older|antig|load|próxim|proxim|next/i,
  maxClicks = 50,
) {
  for (let i = 0; i < maxClicks; i++) {
    const btn = page.locator('button, a').filter({ hasText: label }).first();
    if ((await btn.count().catch(() => 0)) === 0) break;
    if (!(await btn.isVisible().catch(() => false))) break;
    await btn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
}

/** O HTML cru tem links/conteúdo suficiente ou parece gated por JS? */
function looksEmpty(html) {
  if (!html) return true;
  try {
    const $ = cheerio.load(html);
    const links = $('a[href]').length;
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    return links < 5 || text.length < 500;
  } catch {
    return true;
  }
}

// Decisão "precisa de JS" cacheada por host para não pagar o custo do browser à toa.
const needsJs = new Map();

export async function fetchSmart(url, { forceRender = false } = {}) {
  const host = hostOf(url);
  if (isBroken(host)) throw new Error(`circuit breaker aberto para host ${host}`);

  if (forceRender || needsJs.get(host)) {
    return fetchRendered(url);
  }

  let staticRes = null;
  try {
    staticRes = await fetchStatic(url);
  } catch (e) {
    warn(`estático falhou (${url}): ${e.message}; tentando Playwright`);
  }
  if (staticRes && !looksEmpty(staticRes.html)) return staticRes;

  needsJs.set(host, true);
  log(`conteúdo ausente no HTML cru de ${host} -> usando Playwright`);
  return fetchRendered(url);
}
