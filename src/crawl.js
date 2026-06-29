// Orquestração: frontier, processamento de jobs, varredura de arquivo e paginação.
import * as cheerio from 'cheerio';
import { stmts } from './db.js';
import { fetchSmart, checkRobots } from './fetch.js';
import { pruneForLLM, extractArticle, fallbackTitle } from './clean.js';
import {
  getCachedSelector, putSelector, validateLinkSelector, applyLinkSelector,
  validateContentSelector,
} from './selectors.js';
import {
  deriveLinkSelector, deriveContentSelector, deriveNextLink,
  extractLinksItemByItem, extractArticleViaLLM,
} from './llm.js';
import { isSubstack, substackArchive } from './substack.js';
import { normalizeUrl, sha256, domainSig, hostOf, log, warn, errorLog } from './util.js';
import { HAS_LLM, RESPECT_ROBOTS } from './config.js';

export function enqueue(url, kind, fromUrl, sourceId) {
  const n = normalizeUrl(url, fromUrl);
  if (!n) return false;
  return stmts.enqueue.run(n, kind, fromUrl || null, sourceId || null).changes > 0;
}

export function upsertSource(seed) {
  const url = typeof seed === 'string' ? seed : seed.url;
  const base = normalizeUrl(url);
  const name = (typeof seed === 'object' && seed.name) || hostOf(base);
  return stmts.upsertSource.get({ name, base_url: base });
}

async function ensureAllowed(url) {
  if (!RESPECT_ROBOTS) return true;
  const { allowed } = await checkRobots(url);
  if (!allowed) warn(`robots.txt bloqueia ${url} (defina CRAWLER_RESPECT_ROBOTS=false para ignorar)`);
  return allowed;
}

export async function processJob(job, opts = {}) {
  const source = job.source_id ? stmts.getSourceById.get(job.source_id) : null;
  if (job.kind === 'article') return processArticle(job, source, opts);
  return processListing(job, source, opts); // listing (default)
}

// ---------------- LISTING ----------------
async function processListing(job, source, opts) {
  const url = job.url;

  // Atalho Substack: usa API JSON pública e pula HTML/LLM.
  if (isSubstack(url)) {
    try {
      const posts = await substackArchive(url);
      if (posts.length) {
        let n = 0;
        for (const p of posts) if (enqueue(p.url, 'article', url, source?.id)) n++;
        log(`substack: ${posts.length} posts (${n} novos) de ${hostOf(url)}`);
        return;
      }
    } catch (e) {
      warn(`atalho substack falhou: ${e.message}`);
    }
  }

  if (!(await ensureAllowed(url))) return;

  const fetched = await fetchSmart(url);
  const html = fetched.html;
  const sig = domainSig(url, 'listing');
  let sel = getCachedSelector(sig);

  // Self-healing: se o seletor cacheado não valida mais, descarta e re-deriva.
  if (sel?.link_selector) {
    const v = validateLinkSelector(html, sel.link_selector, sel.link_attribute, url);
    if (!v.ok) {
      log(`seletor cacheado falhou (${v.count} links) p/ ${sig} -> re-derivando`);
      sel = null;
    }
  }

  // Deriva com o Pro (xhigh) se necessário.
  if (!sel?.link_selector && HAS_LLM) {
    try {
      const cand = await deriveLinkSelector(pruneForLLM(html));
      const v = validateLinkSelector(html, cand.selector, cand.attribute, url);
      if (v.ok) {
        sel = putSelector(sig, {
          link_selector: cand.selector,
          link_attribute: cand.attribute,
          model_used: 'deepseek-v4-pro',
          confidence: cand.confidence,
        });
        log(`seletor derivado p/ ${sig}: "${cand.selector}" (${v.count} links)`);
      } else {
        warn(`seletor do Pro inválido (${v.count} links) — fallback Flash item-a-item`);
      }
    } catch (e) {
      warn(`deriveLinkSelector falhou: ${e.message}`);
    }
  }

  if (sel?.link_selector) {
    await crawlArchive(url, source, sel, opts, html);
    return;
  }

  // Fallback item-a-item (Flash) quando não há seletor confiável.
  if (HAS_LLM) {
    const links = await extractLinksItemByItem(pruneForLLM(html));
    let n = 0;
    for (const l of links) if (enqueue(l.url, 'article', url, source?.id)) n++;
    log(`fallback Flash: ${n} links enfileirados de ${url}`);
  } else {
    warn(`sem OPENROUTER_API_KEY e sem seletor cacheado — não há como descobrir links em ${url}`);
  }
}

/** Pagina do arquivo até parar: página vazia, hash repetido, ou sem "próximo". */
async function crawlArchive(startUrl, source, sel, opts, firstHtml = null) {
  const maxPages = opts.maxPages ?? Infinity;
  const seenHashes = new Set();
  let pageUrl = startUrl;
  let html = firstHtml;
  let depth = 0;

  while (pageUrl && depth < maxPages) {
    if (html == null) html = (await fetchSmart(pageUrl)).html;

    const h = sha256(html);
    if (seenHashes.has(h)) {
      log(`paginação: conteúdo repetido, parando em ${pageUrl}`);
      break;
    }
    seenHashes.add(h);

    const v = validateLinkSelector(html, sel.link_selector, sel.link_attribute, pageUrl);
    if (!v.ok || v.urls.length === 0) {
      log(`paginação: sem links em ${pageUrl}, parando`);
      break;
    }

    let added = 0;
    for (const u of v.urls) if (enqueue(u, 'article', pageUrl, source?.id)) added++;
    stmts.upsertPage.run({
      source_id: source?.id ?? null,
      url: normalizeUrl(pageUrl),
      html_hash: h,
      status: 'done',
      pagination_depth: depth,
    });
    log(`arquivo p${depth}: ${v.urls.length} links (${added} novos) em ${pageUrl}`);

    const next = await findNextPage(html, pageUrl, sel);
    if (!next || normalizeUrl(next) === normalizeUrl(pageUrl)) {
      log(`paginação: sem próxima página após ${pageUrl}`);
      break;
    }
    pageUrl = next;
    html = null; // força fetch da próxima
    depth++;
  }
}

/** Acha a próxima página: cache -> rel=next -> ?page=N -> LLM (Flash, cacheia o seletor). */
async function findNextPage(html, baseUrl, sel) {
  if (sel?.next_selector) {
    const urls = applyLinkSelector(html, sel.next_selector, 'href', baseUrl);
    if (urls.length) return urls[0];
  }

  const $ = cheerio.load(html);
  const relNext = $('a[rel="next"]').attr('href');
  if (relNext) return normalizeUrl(relNext, baseUrl);

  const cur = new URL(baseUrl);
  const pageParam = cur.searchParams.get('page');
  if (pageParam && /^\d+$/.test(pageParam)) {
    cur.searchParams.set('page', String(Number(pageParam) + 1));
    return cur.href;
  }

  if (HAS_LLM) {
    try {
      const out = await deriveNextLink(pruneForLLM(html), baseUrl);
      if (out.selector) putSelector(domainSig(baseUrl, 'listing'), { next_selector: out.selector });
      if (out.next_url) return normalizeUrl(out.next_url, baseUrl);
    } catch (e) {
      warn(`deriveNextLink falhou: ${e.message}`);
    }
  }
  return null;
}

// ---------------- ARTICLE ----------------
async function processArticle(job, source, opts) {
  const url = job.url;
  if (!(await ensureAllowed(url))) return;

  const html = (await fetchSmart(url)).html;
  let title = null;
  let content = null;
  let published = null;

  // 1) Readability.
  const art = extractArticle(html, url);
  if (art?.textContent && art.textContent.trim().length >= 400) {
    title = art.title;
    content = art.textContent.trim();
    published = art.publishedTime || null;
  } else {
    // 2) Seletor de conteúdo (cacheado ou derivado uma vez via Pro).
    const sig = domainSig(url, 'article');
    let csel = getCachedSelector(sig);
    if (!csel?.content_selector && HAS_LLM) {
      try {
        const cand = await deriveContentSelector(pruneForLLM(html));
        if (validateContentSelector(html, cand.content_selector).ok) {
          csel = putSelector(sig, {
            content_selector: cand.content_selector,
            model_used: 'deepseek-v4-pro',
            confidence: cand.confidence,
          });
          log(`content selector derivado p/ ${sig}: "${cand.content_selector}"`);
        }
      } catch (e) {
        warn(`deriveContentSelector falhou: ${e.message}`);
      }
    }
    if (csel?.content_selector) {
      const v = validateContentSelector(html, csel.content_selector);
      if (v.ok) content = v.result.text;
    }
    // 3) Fallback final: extração direta via LLM (Flash).
    if (!content && HAS_LLM) {
      try {
        const out = await extractArticleViaLLM(pruneForLLM(html));
        title = out.title;
        content = out.content;
        published = out.published_at;
      } catch (e) {
        warn(`extractArticleViaLLM falhou: ${e.message}`);
      }
    }
    if (!title) title = fallbackTitle(html) || url;
  }

  if (!content || content.length < 50) {
    warn(`sem conteúdo extraível em ${url}`);
    return;
  }

  const contentHash = sha256(content);
  if (stmts.getArticleByHash.get(contentHash)) {
    log(`artigo duplicado (hash) ignorado: ${url}`);
    return;
  }

  stmts.insertArticle.run({
    source_id: source?.id ?? null,
    url: normalizeUrl(url),
    title: title || url,
    content,
    content_hash: contentHash,
    published_at: published || null,
  });
  log(`artigo salvo: ${(title || url).slice(0, 80)}`);
}
