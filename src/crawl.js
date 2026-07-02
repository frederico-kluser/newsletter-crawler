// Orquestração: frontier, processamento de jobs, varredura de arquivo e paginação.
import * as cheerio from 'cheerio';
import { stmts } from './db.js';
import { fetchSmart, checkRobots } from './fetch.js';
import {
  pruneForLLM, extractArticle, fallbackTitle, readableLinks, linksInHtml, isBlockedPage,
  extractPublishedDate,
} from './clean.js';
import {
  getCachedSelector, putSelector, validateLinkSelector, applyLinkSelector,
  applyLinkSelectorWithDates, validateContentSelector,
} from './selectors.js';
import {
  deriveLinkSelector, deriveContentSelector, deriveNextLink,
  extractLinksItemByItem, extractArticleViaLLM, extractRoundupLinks,
} from './llm.js';
import { isSubstack, substackArchive } from './substack.js';
import {
  normalizeUrl, sha256, domainSig, hostOf, parseDate, log, warn, errorLog, debug,
} from './util.js';
import {
  HAS_LLM, RESPECT_ROBOTS, MAX_CRAWL_DEPTH, ROUNDUP_MIN_LINKS,
  ARTICLE_ROUNDUP_MIN_LINKS, ARTICLE_ROUNDUP_MAX_LINKS, ROUNDUP_MAX_PROSE_CHARS,
  SINCE_MAX_INDEX_PAGES,
} from './config.js';

export function enqueue(url, kind, fromUrl, sourceId, depth = 0) {
  const n = normalizeUrl(url, fromUrl);
  if (!n) return false;
  return stmts.enqueue.run(n, kind, fromUrl || null, sourceId || null, depth).changes > 0;
}

export function upsertSource(seed) {
  const url = typeof seed === 'string' ? seed : seed.url;
  const base = normalizeUrl(url);
  const name = (typeof seed === 'object' && seed.name) || hostOf(base);
  const type = (typeof seed === 'object' && seed.type) || 'listing';
  const maxIndexPages =
    typeof seed === 'object' && seed.maxIndexPages != null ? Number(seed.maxIndexPages) : null;
  return stmts.upsertSource.get({ name, base_url: base, type, max_index_pages: maxIndexPages });
}

/** Filtra/normaliza links EXTERNOS (outro host) e únicos — base do roundup. */
function externalLinks(links, pageUrl) {
  const host = hostOf(pageUrl);
  const out = new Map();
  for (const l of links || []) {
    const abs = normalizeUrl(l.url, pageUrl);
    if (!abs || !/^https?:/i.test(abs)) continue;
    const h = hostOf(abs);
    if (!h || h === host) continue; // ignora links internos da própria newsletter
    if (!out.has(abs)) out.set(abs, { url: abs, title: (l.title || '').trim() });
  }
  return [...out.values()];
}

/**
 * Links curados de uma issue/roundup: primeiro via corpo do Readability (geral, sem LLM e já
 * sem sponsor/nav); se vier pouco, cai p/ extração via LLM. Retorna links externos únicos.
 */
async function roundupLinks(html, pageUrl) {
  const { links } = readableLinks(html, pageUrl);
  let ext = externalLinks(links, pageUrl);
  debug(`roundup ${pageUrl}: ${ext.length} links externos via Readability`);
  if (ext.length >= ROUNDUP_MIN_LINKS) return ext;

  if (HAS_LLM) {
    try {
      const llm = await extractRoundupLinks(pruneForLLM(html), pageUrl);
      const ext2 = externalLinks(llm, pageUrl);
      debug(`roundup ${pageUrl}: ${ext2.length} links externos via LLM (fallback)`);
      if (ext2.length > ext.length) ext = ext2;
    } catch (e) {
      warn(`extractRoundupLinks falhou (${pageUrl}): ${e.message}`);
    }
  }
  return ext;
}

async function ensureAllowed(url, opts = {}) {
  if (opts.aggressive) return true; // modo agressivo: ignora robots.txt explicitamente
  if (!RESPECT_ROBOTS) return true;
  const { allowed } = await checkRobots(url);
  if (!allowed) warn(`robots.txt bloqueia ${url} (use --aggressive ou CRAWLER_RESPECT_ROBOTS=false para ignorar)`);
  return allowed;
}

export async function processJob(job, opts = {}) {
  const source = job.source_id ? stmts.getSourceById.get(job.source_id) : null;
  debug(`job ${job.kind} d=${job.depth ?? 0} ${job.url}`);
  if (job.kind === 'article') return processArticle(job, source, opts);
  if (job.kind === 'roundup') return processRoundup(job, source, opts);
  return processListing(job, source, opts); // listing (default)
}

// ---------------- LISTING ----------------
async function processListing(job, source, opts) {
  const url = job.url;
  const depth = job.depth ?? 0;
  // `index` => os filhos são roundups (issues); senão => os filhos são artigos (default).
  const isIndex = source?.type === 'index';
  const childKind = isIndex ? 'roundup' : 'article';
  // O índice só pagina a 1ª página por padrão (max_index_pages); listagem normal usa --max-pages.
  // Com --since, o índice pode paginar mais fundo (a data é que para), até um teto de segurança.
  const maxPages = isIndex
    ? opts.sinceDate
      ? Math.max(source?.max_index_pages ?? 1, SINCE_MAX_INDEX_PAGES)
      : source?.max_index_pages != null
        ? source.max_index_pages
        : opts.maxPages ?? 1
    : opts.maxPages ?? Infinity;

  // Atalho Substack: usa API JSON pública e pula HTML/LLM.
  if (isSubstack(url)) {
    try {
      const posts = await substackArchive(url);
      if (posts.length) {
        let n = 0;
        for (const p of posts) {
          if (opts.sinceDate) {
            const d = parseDate(p.published_at);
            if (d && d < opts.sinceDate) continue; // piso: pula posts mais antigos
          }
          if (enqueue(p.url, childKind, url, source?.id, depth + 1)) n++;
        }
        log(`substack: ${posts.length} posts (${n} novos) de ${hostOf(url)}`);
        return;
      }
    } catch (e) {
      warn(`atalho substack falhou: ${e.message}`);
    }
  }

  if (!(await ensureAllowed(url, opts))) return;

  const fetched = await fetchSmart(url, { aggressive: opts.aggressive });
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
    await crawlArchive(url, source, sel, html, {
      childKind, baseDepth: depth, maxPages, sinceDate: opts.sinceDate, aggressive: opts.aggressive,
    });
    return;
  }

  // Fallback item-a-item (Flash) quando não há seletor confiável.
  if (HAS_LLM) {
    const links = await extractLinksItemByItem(pruneForLLM(html));
    let n = 0;
    for (const l of links) if (enqueue(l.url, childKind, url, source?.id, depth + 1)) n++;
    log(`fallback Flash: ${n} links (${childKind}) enfileirados de ${url}`);
  } else {
    warn(`sem OPENROUTER_API_KEY e sem seletor cacheado — não há como descobrir links em ${url}`);
  }
}

/** Pagina do arquivo até parar: página vazia, hash repetido, ou sem "próximo". */
async function crawlArchive(startUrl, source, sel, firstHtml, ctx) {
  const { childKind = 'article', baseDepth = 0, maxPages = Infinity, sinceDate = null, aggressive = false } = ctx || {};
  const seenHashes = new Set();
  let pageUrl = startUrl;
  let html = firstHtml;
  let depth = 0;

  while (pageUrl && depth < maxPages) {
    if (html == null) html = (await fetchSmart(pageUrl, { aggressive })).html;

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

    // Com --since, pareia cada link à sua data (do <time> do item) p/ aplicar o piso já aqui e
    // PARAR a paginação ao ver o 1º item abaixo do piso (a lista do arquivo é decrescente).
    const dated = sinceDate
      ? applyLinkSelectorWithDates(html, sel.link_selector, sel.link_attribute, pageUrl)
      : v.urls.map((u) => ({ url: u, date: null }));
    let added = 0;
    let below = 0;
    for (const it of dated) {
      const d = sinceDate ? parseDate(it.date) : null;
      if (sinceDate && d && d < sinceDate) {
        below++; // mais antigo que o piso: não enfileira
        continue;
      }
      if (enqueue(it.url, childKind, pageUrl, source?.id, baseDepth + 1)) added++;
    }
    stmts.upsertPage.run({
      source_id: source?.id ?? null,
      url: normalizeUrl(pageUrl),
      html_hash: h,
      status: 'done',
      pagination_depth: depth,
    });
    log(
      `arquivo p${depth}: ${dated.length} links ${childKind} (${added} novos` +
        `${sinceDate ? `, ${below} < --since` : ''}) em ${pageUrl}`,
    );

    if (sinceDate && below > 0) {
      log(`--since: piso atingido, parando paginação em ${pageUrl}`);
      break;
    }
    // Re-crawl incremental: página sem nenhum link novo => chegamos ao território já conhecido.
    // O arquivo é decrescente (mesma premissa do piso --since acima), logo tudo adiante é conhecido.
    if (added === 0) {
      log(`paginação: 0 links novos em ${pageUrl}, parando (incremental)`);
      break;
    }
    if (depth + 1 >= maxPages) break; // não vamos paginar -> evita findNextPage (pode custar 1 LLM)
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

// ---------------- ROUNDUP (issue/edição: lista de links externos curados) ----------------
async function processRoundup(job, source, opts = {}) {
  const url = job.url;
  const depth = job.depth ?? 0;
  if (!(await ensureAllowed(url, opts))) return;

  const fetched = await fetchSmart(url, { aggressive: opts.aggressive });
  const finalUrl = fetched.url || url;

  // Piso por data da ISSUE (backstop autoritativo p/ itens do índice sem data legível). Como
  // descartamos a issue ANTES de enfileirar artigos, todo artigo enfileirado é de issue no piso.
  if (opts.sinceDate) {
    const d = parseDate(extractPublishedDate(fetched.html));
    if (d && d < opts.sinceDate) {
      log(`issue anterior a --since (${d.toISOString().slice(0, 10)}) ignorada: ${url}`);
      return;
    }
  }

  const links = await roundupLinks(fetched.html, finalUrl);
  if (!links.length) {
    warn(`roundup sem links externos (nada enfileirado): ${url}`);
    return;
  }
  let n = 0;
  for (const l of links) if (enqueue(l.url, 'article', url, source?.id, depth + 1)) n++;
  log(`roundup: ${links.length} links externos (${n} novos) em ${url.slice(0, 80)}`);
}

// ---------------- ARTICLE ----------------
async function processArticle(job, source, opts) {
  const url = job.url;
  const depth = job.depth ?? 0;
  if (!(await ensureAllowed(url, opts))) return;

  const fetched = await fetchSmart(url, { aggressive: opts.aggressive });
  const html = fetched.html;
  const finalUrl = fetched.url || url;
  // Identidade canônica pós-redirect: dedup mesmo quando A->B (alias de redirect). Checa ANTES
  // de extrair — não cadastra 2x o mesmo link e economiza extração/LLM. (content_hash é backstop.)
  const canonicalUrl = normalizeUrl(finalUrl) || normalizeUrl(url) || finalUrl;
  if (stmts.getArticleByUrl.get(canonicalUrl)) {
    log(`artigo já existe (url canônica) ignorado: ${url}`);
    return;
  }
  let title = null;
  let content = null;
  let published = null;

  // 1) Readability (uma vez; reaproveitado p/ roundup-detection e p/ extração do corpo).
  const art = extractArticle(html, finalUrl);

  // Roundup-detection: às vezes um "link" aponta p/ uma página que é uma COLEÇÃO de várias
  // notícias. Só dividimos quando a página é PREDOMINANTEMENTE uma lista de links (pouca prosa)
  // e o nº de links externos está numa faixa "de roundup" — assim um paper com 150 referências
  // (que é UM artigo) não é destruído. Limitado por MAX_CRAWL_DEPTH p/ não recursar sem fim.
  if (depth < MAX_CRAWL_DEPTH && art?.content) {
    const proseLen = art.textContent?.trim().length || 0;
    const ext = externalLinks(linksInHtml(art.content, finalUrl), finalUrl);
    const looksLikeCollection =
      ext.length >= ARTICLE_ROUNDUP_MIN_LINKS &&
      ext.length <= ARTICLE_ROUNDUP_MAX_LINKS &&
      proseLen < ROUNDUP_MAX_PROSE_CHARS;
    if (looksLikeCollection) {
      let n = 0;
      for (const l of ext) if (enqueue(l.url, 'article', url, source?.id, depth + 1)) n++;
      log(`artigo é roundup (${ext.length} links, ${proseLen} chars prosa) -> dividido em ${n}: ${url.slice(0, 60)}`);
      return;
    }
  }

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

  // Descarta interstitials anti-bot (Cloudflare "Just a moment...", captcha) — vêm com 200 mas
  // não são artigo. Evita salvar lixo quando o site bloqueia o crawler.
  if (isBlockedPage(title, content)) {
    warn(`página anti-bot/bloqueada ignorada (sem artigo real): ${url}`);
    return;
  }

  // Piso por data do ARTIGO ("ambos"): descarta artigo com data PRÓPRIA anterior ao piso.
  // Data nula é mantida — sua issue de origem já está dentro do piso (por construção).
  if (opts.sinceDate) {
    const d = parseDate(published);
    if (d && d < opts.sinceDate) {
      log(`artigo anterior a --since (${published}) ignorado: ${url}`);
      return;
    }
  }

  const contentHash = sha256(content);
  if (stmts.getArticleByHash.get(contentHash)) {
    log(`artigo duplicado (hash) ignorado: ${url}`);
    return;
  }

  stmts.insertArticle.run({
    source_id: source?.id ?? null,
    url: canonicalUrl,
    title: title || canonicalUrl,
    content,
    content_hash: contentHash,
    published_at: published || null,
    run_id: opts.runId ?? null,
  });
  log(`artigo salvo: ${(title || canonicalUrl).slice(0, 80)}`);
}
