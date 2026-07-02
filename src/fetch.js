// Busca de HTML: estático (got), renderizado (Playwright), e decisão automática (fetchSmart).
import got from 'got';
import { chromium } from 'playwright';
import robotsParser from 'robots-parser';
import pLimit from 'p-limit';
import * as cheerio from 'cheerio';
import {
  USER_AGENT, REQUEST_DELAY_MS, PER_HOST_CONCURRENCY, MAX_RETRIES, RESPECT_ROBOTS,
} from './config.js';
import { getLane } from './governor.js';
import { hostOf, sleep, log, warn, debug } from './util.js';

// ---- concorrência e circuit breaker por host ----
const hostLimiters = new Map();
function hostLimit(host) {
  if (!hostLimiters.has(host)) hostLimiters.set(host, pLimit(PER_HOST_CONCURRENCY));
  return hostLimiters.get(host);
}

/**
 * Circuit breaker por host com half-open: N falhas consecutivas abrem; após o cooldown,
 * UMA probe passa — sucesso fecha, falha reabre dobrando o cooldown (até o teto). Fábrica
 * pura (clock injetável) p/ teste; o singleton do módulo usa Date.now.
 */
export function createBreaker({
  now = Date.now, threshold = 5, baseCooldownMs = 60_000, maxCooldownMs = 900_000,
} = {}) {
  const m = new Map();
  const get = (h) => {
    if (!m.has(h)) m.set(h, { fails: 0, state: 'closed', cooldownMs: baseCooldownMs, openedAt: 0, probing: false });
    return m.get(h);
  };
  return {
    canRequest(h) {
      const b = get(h);
      if (b.state === 'closed') return true;
      if (b.state === 'open') {
        if (now() - b.openedAt < b.cooldownMs) return false;
        b.state = 'halfOpen';
        debug(`breaker: ${h} half-open (probe única)`);
      }
      if (b.probing) return false; // já há uma probe em voo
      b.probing = true;
      return true;
    },
    recordOk(h) {
      const b = get(h);
      m.set(h, { ...b, fails: 0, state: 'closed', probing: false, cooldownMs: baseCooldownMs });
    },
    recordError(h) {
      const b = get(h);
      if (b.state === 'halfOpen') {
        b.state = 'open';
        b.openedAt = now();
        b.probing = false;
        b.cooldownMs = Math.min(b.cooldownMs * 2, maxCooldownMs);
        warn(`breaker: probe de ${h} falhou — reaberto por ${Math.round(b.cooldownMs / 1000)}s`);
        return;
      }
      b.fails += 1;
      if (b.state === 'closed' && b.fails >= threshold) {
        b.state = 'open';
        b.openedAt = now();
        warn(`breaker: ${h} aberto (${b.fails} falhas consecutivas) por ${Math.round(b.cooldownMs / 1000)}s`);
      }
    },
    stateOf(h) {
      return get(h).state;
    },
  };
}
const breaker = createBreaker();
const recordError = (h) => breaker.recordError(h);
const recordOk = (h) => breaker.recordOk(h);

/**
 * Politeness por host: gap INTER-REQUEST serializado (reserva de timeline), honrando o
 * crawl-delay do robots (cap 30s) e no mínimo o jitter de REQUEST_DELAY_MS. Com N slots por
 * host, vira fila — é exatamente o que a politeness pede. Fábrica pura p/ teste de gaps.
 */
export function createHostGate({
  now = Date.now, wait = sleep, baseDelayMs = REQUEST_DELAY_MS, maxCrawlDelayMs = 30_000,
  random = Math.random,
} = {}) {
  const nextAllowedAt = new Map();
  return {
    /** Aguarda a vez deste host e reserva o gap p/ o próximo request. */
    async pause(host, crawlDelayMs = 0) {
      const gap = Math.max(
        Math.min(crawlDelayMs || 0, maxCrawlDelayMs),
        Math.round(baseDelayMs * (0.5 + random())),
      );
      const t = now();
      const at = Math.max(t, nextAllowedAt.get(host) || 0);
      nextAllowedAt.set(host, at + gap);
      if (at > t) await wait(at - t);
    },
  };
}
const hostGate = createHostGate();

/** Gap de politeness do host (dentro do slot do host-limiter), com o crawl-delay do robots. */
async function politePause(host, url) {
  let crawlDelay = 0;
  if (RESPECT_ROBOTS) {
    try {
      crawlDelay = (await checkRobots(url)).crawlDelay || 0;
    } catch {
      /* robots é best-effort; o jitter mínimo ainda vale */
    }
  }
  await hostGate.pause(host, crawlDelay);
}

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
// Host limiter por FORA (politeness é invariante, não escala com a máquina); a lane fetch do
// governador por dentro limita o total de requests simultâneos na máquina inteira.
export async function fetchStatic(url) {
  const host = hostOf(url);
  return hostLimit(host)(async () => {
    await politePause(host, url);
    return getLane('fetch')(async () => {
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

// Perfis de render (B5): um ARTIGO não tem scroll infinito nem "carregar mais" — rolar 60
// rounds e clicar 50 botões nele só queima slot/RAM. O deadline é o teto de TEMPO do render
// (pior caso caía em ~12 min; com perfis vira <=90s p/ artigo e <=240s p/ listagem).
const RENDER_PROFILES = {
  article: { scrollRounds: 8, loadMore: false, deadlineMs: 90_000 },
  listing: { scrollRounds: 60, loadMore: true, deadlineMs: 240_000 },
};

export async function fetchRendered(url, { profile = 'listing' } = {}) {
  const host = hostOf(url);
  const prof = RENDER_PROFILES[profile] || RENDER_PROFILES.listing;
  return hostLimit(host)(async () => {
    await politePause(host, url);
    // Lane render cobre a vida INTEIRA do contexto (newContext -> close): o permit da lane é
    // exatamente a pegada de RAM de um Chromium context — é isso que o governador conta.
    return getLane('render')(async () => {
      const deadline = Date.now() + prof.deadlineMs;
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
        await autoScroll(page, { maxRounds: prof.scrollRounds, deadline });
        if (prof.loadMore) await clickLoadMore(page, undefined, 50, deadline);
        if (Date.now() >= deadline) log(`render truncado pelo deadline (${profile}): ${url.slice(0, 80)}`);
        const html = await page.content();
        recordOk(host);
        return { html, status: 200, url: page.url(), rendered: true };
      } catch (e) {
        recordError(host);
        throw e;
      } finally {
        await ctx.close().catch(() => {});
      }
    });
  });
}

/** Rola até a altura parar de crescer (detecta fim de scroll infinito) ou até o deadline. */
export async function autoScroll(page, { step = 1200, pause = 800, maxRounds = 60, deadline = Infinity } = {}) {
  let prev = 0;
  for (let i = 0; i < maxRounds && Date.now() < deadline; i++) {
    const h = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
    if (!h || h === prev) break;
    prev = h;
    await page.evaluate((s) => window.scrollBy(0, s), step).catch(() => {});
    await page.waitForTimeout(pause);
  }
}

/** Clica repetidamente em botões "carregar mais / mais antigos / próximo" (até o deadline). */
export async function clickLoadMore(
  page,
  label = /mais|more|older|antig|load|próxim|proxim|next/i,
  maxClicks = 50,
  deadline = Infinity,
) {
  for (let i = 0; i < maxClicks && Date.now() < deadline; i++) {
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

export async function fetchSmart(url, { forceRender = false, profile = 'listing' } = {}) {
  const host = hostOf(url);
  if (!breaker.canRequest(host)) throw new Error(`circuit breaker aberto para host ${host}`);

  if (forceRender || needsJs.get(host)) {
    return fetchRendered(url, { profile });
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
  return fetchRendered(url, { profile });
}
