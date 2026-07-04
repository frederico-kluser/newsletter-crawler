// Busca de HTML: estático (got), renderizado (Playwright), e decisão automática (fetchSmart).
import got from 'got';
import { chromium } from 'playwright';
import robotsParser from 'robots-parser';
import pLimit from 'p-limit';
import * as cheerio from 'cheerio';
import {
  USER_AGENT, REQUEST_DELAY_MS, PER_HOST_CONCURRENCY, MAX_RETRIES, RESPECT_ROBOTS,
  SCROLL_STALL_CHECKS, SCROLL_STEP, SCROLL_SETTLE_MAX_MS, SCROLL_ROUNDS, SCROLL_ROUNDS_ARTICLE,
  RENDER_LISTING_DEADLINE_MS, RENDER_ARTICLE_DEADLINE_MS, MAX_LOAD_MORE,
} from './config.js';
import { getLane } from './governor.js';
import { inStage } from './progress.js';
import { abortErrorOf } from './deadline.js';
import { hostOf, sleep, log, warn, debug, parseDate } from './util.js';

// ---- integração com o relógio de trabalho do job (deadline.js) ----
// `clock.run(fase, fn)` conta o tempo de fn no orçamento do job; sem clock, roda direto.
// `throwIfAborted` corta cedo um job já abortado ANTES de ele reservar politeness/lane — é o
// que impede o zumbi de continuar consumindo a timeline do host e as filas.
const runOn = (clock, phase, fn) => (clock ? clock.run(phase, fn) : fn());
const throwIfAborted = (signal) => {
  if (signal?.aborted) throw abortErrorOf(signal);
};

// ---- modo agressivo: identidade de navegador real (UA + headers/client-hints) ----
// Opt-in por execução (--aggressive). MANTENHA sec-ch-ua em sincronia com a versão do BROWSER_UA.
// Override do UA via env CRAWLER_AGGRESSIVE_UA (mesma convenção de CRAWLER_UA).
const BROWSER_UA =
  process.env.CRAWLER_AGGRESSIVE_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const AGGRESSIVE_CH = {
  'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};
// Conjunto completo de headers de uma navegação de documento real (caminho estático via got).
const AGGRESSIVE_HEADERS = {
  'user-agent': BROWSER_UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  ...AGGRESSIVE_CH,
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};

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
export async function fetchStatic(url, { aggressive = false, clock = null, signal = null } = {}) {
  const host = hostOf(url);
  const tQueue = Date.now();
  return hostLimit(host)(async () => {
    throwIfAborted(signal); // job abortado não reserva a timeline de politeness do host
    clock?.noteWait('hostQueue', Date.now() - tQueue);
    const pol = () => politePause(host, url);
    await (clock ? clock.wait('polite', pol) : pol());
    throwIfAborted(signal);
    const tLane = Date.now();
    return getLane('fetch')(async () => {
      clock?.noteWait('fetchLane', Date.now() - tLane);
      throwIfAborted(signal);
      return inStage('fetch', () => runOn(clock, 'fetch', async () => {
        try {
          const res = await got(url, {
            headers: aggressive
              ? AGGRESSIVE_HEADERS
              : { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
            timeout: { request: 20000 },
            retry: { limit: MAX_RETRIES, methods: ['GET'], statusCodes: [408, 429, 500, 502, 503, 504] },
            followRedirect: true,
            signal: signal || undefined, // abort do job cancela o request em voo
          });
          recordOk(host);
          return { html: res.body, status: res.statusCode, url: res.url, rendered: false };
        } catch (e) {
          // Abort do job não é falha do host: não conta no circuit breaker.
          if (signal?.aborted) throw abortErrorOf(signal);
          recordError(host);
          throw e;
        }
      }));
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

// Perfis de render (constante perdida no merge paralel+robot-bypass — sem ela TODO fetch
// renderizado crashava com "RENDER_PROFILES is not defined"): listagem rola até o fim e
// clica "load more" (arquivo infinito); artigo é curto e sem cliques (só precisa do corpo).
const RENDER_PROFILES = {
  listing: { deadlineMs: RENDER_LISTING_DEADLINE_MS, scrollRounds: SCROLL_ROUNDS, loadMore: true },
  article: { deadlineMs: RENDER_ARTICLE_DEADLINE_MS, scrollRounds: SCROLL_ROUNDS_ARTICLE, loadMore: false },
};

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

export async function fetchRendered(url, {
  profile = 'listing', aggressive = false, clock = null, signal = null, sinceDate = null,
} = {}) {
  const host = hostOf(url);
  const prof = RENDER_PROFILES[profile] || RENDER_PROFILES.listing;
  const tQueue = Date.now();
  return hostLimit(host)(async () => {
    throwIfAborted(signal); // job abortado não reserva a timeline de politeness do host
    clock?.noteWait('hostQueue', Date.now() - tQueue);
    const pol = () => politePause(host, url);
    await (clock ? clock.wait('polite', pol) : pol());
    throwIfAborted(signal);
    // Lane render cobre a vida INTEIRA do contexto (newContext -> close): o permit da lane é
    // exatamente a pegada de RAM de um Chromium context — é isso que o governador conta.
    const tLane = Date.now();
    return getLane('render')(async () => {
      clock?.noteWait('renderLane', Date.now() - tLane);
      throwIfAborted(signal);
      return inStage('render', () => runOn(clock, 'render', async () => {
      const deadline = Date.now() + prof.deadlineMs;
      const browser = await getBrowser();
      // ignoreHTTPSErrors: alguns veículos têm cert com CN inválido (ex.: kedglobal.com ->
      // ERR_CERT_COMMON_NAME_INVALID). Para crawler de artigos públicos, seguir mesmo assim.
      // Modo agressivo: UA de navegador real + locale + client-hints.
      const ctx = await browser.newContext(
        aggressive
          ? {
              userAgent: BROWSER_UA,
              locale: 'en-US',
              ignoreHTTPSErrors: true,
              extraHTTPHeaders: { ...AGGRESSIVE_CH, 'upgrade-insecure-requests': '1' },
            }
          : { userAgent: USER_AGENT, ignoreHTTPSErrors: true },
      );
      const page = await ctx.newPage();
      try {
        await page.route('**/*', (route) => {
          const t = route.request().resourceType();
          return ['image', 'media', 'font'].includes(t) ? route.abort() : route.continue();
        });
        throwIfAborted(signal);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        // Listagem: scroll INTELIGENTE — colhe {href,texto,datetime} a cada rodada (aguenta feed
        // virtualizado que descarta itens do DOM) e para por data (--since), estagnação ou teto.
        const collect = profile === 'listing';
        const scroll = await autoScroll(page, {
          maxRounds: prof.scrollRounds, deadline, signal,
          collect, sinceDate: collect ? sinceDate : null,
        });
        // Piso de data alcançado: clicar "older/load more" só traria itens ainda mais antigos.
        // Fora do piso: clica repetidamente e RE-COLHE entre cada clique (feed virtualizado
        // descarta itens do DOM entre páginas) acumulando na mesma colheita do scroll.
        if (prof.loadMore && scroll.reason !== 'piso') {
          await clickLoadMore(page, { deadline, signal, harvest: collect ? scroll.harvest : null });
        }
        if (collect) scroll.harvest.push(...(await harvestNewLinks(page))); // rede de segurança final
        if (Date.now() >= deadline) log(`render truncado pelo deadline (${profile}): ${url.slice(0, 80)}`);
        if (collect && !['rodadas', 'plateau'].includes(scroll.reason)) {
          log(`scroll parado (${scroll.reason}) após ${scroll.rounds} rodadas, ${scroll.harvest.length} links vistos: ${url.slice(0, 80)}`);
        }
        const html = await page.content();
        recordOk(host);
        return { html, status: 200, url: page.url(), rendered: true, harvest: collect ? scroll.harvest : undefined };
      } catch (e) {
        // Abort do job não é falha do host: não conta no circuit breaker.
        if (signal?.aborted) throw abortErrorOf(signal);
        recordError(host);
        throw e;
      } finally {
        await ctx.close().catch(() => {});
      }
      }));
    });
  });
}

/**
 * Decisão PURA de uma rodada de scroll (testável sem browser). Modo simples (artigo): para no
 * platô de altura (comportamento clássico). Modo collect (listagem): NÃO confia na altura (feed
 * virtualizado recicla DOM com altura ~constante) — para por 'piso' (>=2 itens novos datados e
 * TODOS abaixo do --since) ou 'estagnado' (stallChecks checagens seguidas sem link novo).
 */
export function scrollRoundDecision({
  collect = false, heightGrew = true, newCount = 0, newDatesMs = [], sinceMs = null,
  stall = 0, stallChecks = SCROLL_STALL_CHECKS,
} = {}) {
  if (!collect) return { stop: heightGrew ? null : 'plateau', stall: 0 };
  if (sinceMs != null && newDatesMs.length >= 2 && newDatesMs.every((t) => t < sinceMs)) {
    return { stop: 'piso', stall };
  }
  const s = newCount === 0 ? stall + 1 : 0;
  return { stop: s >= stallChecks ? 'estagnado' : null, stall: s };
}

// Colheita incremental no browser: só os links AINDA NÃO VISTOS (Set no window persiste entre
// evaluates da mesma page), com a data <time datetime> do container do item quando houver. O
// walk para no ancestral com >3 links (é a lista, não o item — evita "emprestar" a data do
// primeiro item da página).
function harvestNewLinks(page) {
  return page
    .evaluate(() => {
      try {
        const seen = (window.__ncSeenLinks ||= new Set());
        const out = [];
        for (const a of document.querySelectorAll('a[href]')) {
          const href = a.href;
          if (!href || seen.has(href)) continue;
          seen.add(href);
          let dt = null;
          let n = a;
          for (let i = 0; i < 4 && n && !dt; i++) {
            if (i > 0 && n.querySelectorAll('a[href]').length > 3) break;
            const t = n.querySelector('time[datetime]');
            if (t) dt = t.getAttribute('datetime');
            n = n.parentElement;
          }
          out.push({ href, text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160), dt });
        }
        return out;
      } catch {
        return [];
      }
    })
    .catch(() => []);
}

// Rola o "scroller" CERTO por `step` px e devolve a altura de rolagem atual. Muitos feeds rolam
// num CONTAINER interno (div com overflow), não na janela — aí window.scrollBy(0,step) não move
// nada. Detecta e cacheia esse container no `window` (o maior elemento rolável); cai p/ a janela.
function scrollOnce(page, step) {
  return page
    .evaluate((s) => {
      let el = window.__ncScroller;
      if (el === undefined || (el && !document.contains(el))) {
        el = null;
        let best = 0;
        for (const n of document.querySelectorAll('body *')) {
          if (n.scrollHeight - n.clientHeight <= 400) continue; // rejeição barata antes do estilo
          if (!/(auto|scroll)/.test(getComputedStyle(n).overflowY)) continue;
          const room = n.scrollHeight - n.clientHeight;
          if (room > best) { best = room; el = n; }
        }
        window.__ncScroller = el; // elemento, ou null = rolar a janela
      }
      const target = el || document.scrollingElement || document.documentElement;
      try { target.scrollTop += s; } catch { /* noop */ }
      window.scrollBy(0, s); // e a janela também (feeds que escutam o scroll do window)
      return Math.max(target.scrollHeight || 0, document.body.scrollHeight || 0);
    }, step)
    .catch(() => 0);
}

// Altura de rolagem atual pelo MESMO critério do scrollOnce (container cacheado ou janela).
function probeHeight(page) {
  return page
    .evaluate(() => {
      const el = window.__ncScroller;
      const t = el || document.scrollingElement || document.documentElement;
      return Math.max(t.scrollHeight || 0, document.body.scrollHeight || 0);
    })
    .catch(() => 0);
}

// Espera ADAPTATIVA pós-scroll: enquanto a altura cresce, continua esperando (feed lento carregando
// aos poucos); assenta quando fica estável por ~400ms; teto duro em `maxMs`. Substitui o pause fixo
// — feed rápido/estático sai em ~400ms; feed lento ganha até maxMs p/ trazer a próxima leva.
async function settleAfterScroll(page, prevHeight, maxMs, signal) {
  const t0 = Date.now();
  let last = prevHeight;
  let stableFor = 0;
  while (Date.now() - t0 < maxMs) {
    if (signal?.aborted) return;
    await page.waitForTimeout(150).catch(() => {});
    const h = await probeHeight(page);
    if (h > last) { last = h; stableFor = 0; } // cresceu: mais conteúdo pode vir, segue esperando
    else if ((stableFor += 150) >= 400) return; // estável por 400ms: assentou
  }
}

/**
 * Rola a página até um motivo de parada. Retorna { rounds, reason, harvest }, onde harvest são
 * os links colhidos DURANTE o scroll (modo collect) — inclui itens que um feed virtualizado já
 * descartou do DOM final. reasons: plateau | piso | estagnado | deadline | abort | sem-altura | rodadas.
 */
export async function autoScroll(page, {
  step = SCROLL_STEP, settleMaxMs = SCROLL_SETTLE_MAX_MS, maxRounds = SCROLL_ROUNDS,
  deadline = Infinity, signal = null, collect = false, sinceDate = null,
  stallChecks = SCROLL_STALL_CHECKS,
} = {}) {
  const sinceMs = sinceDate instanceof Date ? sinceDate.getTime() : null;
  const harvest = [];
  let prev = 0;
  let stall = 0;
  let rounds = 0;
  let reason = null;
  for (let i = 0; i < maxRounds; i++) {
    if (signal?.aborted) {
      reason = 'abort';
      break;
    }
    if (Date.now() >= deadline) {
      reason = 'deadline';
      break;
    }
    const h = await probeHeight(page);
    let fresh = [];
    if (collect) {
      fresh = await harvestNewLinks(page);
      harvest.push(...fresh);
    }
    const dec = scrollRoundDecision({
      collect,
      heightGrew: h > 0 && h !== prev,
      newCount: fresh.length,
      newDatesMs:
        collect && sinceMs != null
          ? fresh.map((it) => parseDate(it.dt)).filter(Boolean).map((d) => d.getTime())
          : [],
      sinceMs,
      stall,
      stallChecks,
    });
    stall = dec.stall;
    if (dec.stop) {
      reason = dec.stop;
      break;
    }
    if (!h) {
      reason = 'sem-altura';
      break;
    }
    prev = h;
    rounds = i + 1;
    await scrollOnce(page, step);
    await settleAfterScroll(page, h, Math.min(settleMaxMs, Math.max(0, deadline - Date.now())), signal);
  }
  return { rounds, reason: reason || 'rodadas', harvest };
}

/**
 * Clica repetidamente em "carregar mais / mais antigos / próximo" até o deadline. Entre cliques,
 * espera a CONTAGEM de <a> crescer (teto curto) em vez de `networkidle` — que em página com
 * websockets/analytics quase nunca dispara e queimava os 8s. Se `harvest` vier, RE-COLHE os links
 * a cada clique (feed virtualizado descarta itens do DOM entre páginas) acumulando nele.
 */
export async function clickLoadMore(page, {
  label = /mais|more|older|antig|load|próxim|proxim|next/i,
  maxClicks = MAX_LOAD_MORE,
  deadline = Infinity,
  signal = null,
  harvest = null,
} = {}) {
  const linkCount = () =>
    page.evaluate(() => document.querySelectorAll('a[href]').length).catch(() => 0);
  for (let i = 0; i < maxClicks && Date.now() < deadline; i++) {
    if (signal?.aborted) return;
    const btn = page.locator('button, a, [role="button"]').filter({ hasText: label }).first();
    if ((await btn.count().catch(() => 0)) === 0) break;
    if (!(await btn.isVisible().catch(() => false))) break;
    const before = await linkCount();
    await btn.click({ timeout: 5000 }).catch(() => {});
    // Espera conteúdo novo (cresce a contagem de <a>) até 4s, sem depender de networkidle.
    const t0 = Date.now();
    while (Date.now() - t0 < 4000 && Date.now() < deadline) {
      if (signal?.aborted) return;
      await page.waitForTimeout(200).catch(() => {});
      if ((await linkCount()) > before) break;
    }
    if (harvest) harvest.push(...(await harvestNewLinks(page)));
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

export async function fetchSmart(url, {
  forceRender = false, profile = 'listing', aggressive = false,
  clock = null, signal = null, sinceDate = null,
} = {}) {
  const host = hostOf(url);
  if (!breaker.canRequest(host)) throw new Error(`circuit breaker aberto para host ${host}`);

  if (forceRender || needsJs.get(host)) {
    return fetchRendered(url, { profile, aggressive, clock, signal, sinceDate });
  }

  let staticRes = null;
  try {
    staticRes = await fetchStatic(url, { aggressive, clock, signal });
  } catch (e) {
    if (signal?.aborted) throw abortErrorOf(signal); // job morto: sem fallback p/ Playwright
    warn(`estático falhou (${url}): ${e.message}; tentando Playwright`);
  }
  if (staticRes && !looksEmpty(staticRes.html)) return staticRes;

  needsJs.set(host, true);
  log(`conteúdo ausente no HTML cru de ${host} -> usando Playwright`);
  return fetchRendered(url, { profile, aggressive, clock, signal, sinceDate });
}
