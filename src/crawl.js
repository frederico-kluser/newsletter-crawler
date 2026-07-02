// Orquestração: frontier, processamento de jobs, varredura de arquivo e paginação.
import * as cheerio from 'cheerio';
import { stmts } from './db.js';
import { fetchSmart, checkRobots } from './fetch.js';
import {
  pruneForLLM, extractArticle, fallbackTitle, readableLinks, linksInHtml, isBlockedPage,
  extractPublishedDate, cpuParse, capHtml, applyJunkSpans,
} from './clean.js';
import {
  getCachedSelector, putSelector, validateLinkSelector, applyLinkSelector,
  applyLinkSelectorWithDates, validateContentSelector,
} from './selectors.js';
import {
  deriveLinkSelector, deriveContentSelector, deriveNextLink, deriveDateSelector,
  extractLinksItemByItem, extractArticleViaLLM, extractRoundupLinks, cleanArticleContent,
} from './llm.js';
import { curateRoundup } from './curate.js';
import { logEvent } from './events.js';
import { isSubstack, substackArchive } from './substack.js';
import {
  normalizeUrl, sha256, domainSig, hostOf, parseDate, log, warn, errorLog, debug,
} from './util.js';
import {
  HAS_LLM, RESPECT_ROBOTS, MAX_CRAWL_DEPTH, ROUNDUP_MIN_LINKS,
  ARTICLE_ROUNDUP_MIN_LINKS, ARTICLE_ROUNDUP_MAX_LINKS, ROUNDUP_MAX_PROSE_CHARS,
  SINCE_MAX_INDEX_PAGES, CURATE_ROUNDUPS, CLEAN_BEFORE_SAVE, CLEAN_MAX_CHARS,
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
  const capped = capHtml(html);
  const { links } = await cpuParse(() => readableLinks(capped, pageUrl));
  let ext = externalLinks(links, pageUrl);
  debug(`roundup ${pageUrl}: ${ext.length} links externos via Readability`);
  if (ext.length >= ROUNDUP_MIN_LINKS) return ext;

  if (HAS_LLM) {
    try {
      const llm = await extractRoundupLinks(await cpuParse(() => pruneForLLM(capped)), pageUrl);
      const ext2 = externalLinks(llm, pageUrl);
      debug(`roundup ${pageUrl}: ${ext2.length} links externos via LLM (fallback)`);
      if (ext2.length > ext.length) ext = ext2;
    } catch (e) {
      // Orçamento: se o Readability já achou ALGO, degrada e segue com isso; sem nada,
      // rethrow p/ o job voltar a pending (retomável) em vez de virar `done` vazio.
      if (e?.code === 'BUDGET_EXCEEDED' && !ext.length) throw e;
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

  const fetched = await fetchSmart(url, { profile: 'listing', aggressive: opts.aggressive });
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
      const cand = await deriveLinkSelector(await cpuParse(() => pruneForLLM(capHtml(html))));
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
      // Orçamento: o fallback item-a-item também é LLM — rethrow p/ o job voltar a pending.
      if (e?.code === 'BUDGET_EXCEEDED') throw e;
      warn(`deriveLinkSelector falhou: ${e.message}`);
    }
  }

  if (sel?.link_selector) {
    await crawlArchive(url, source, sel, html, {
      childKind, baseDepth: depth, maxPages, sinceDate: opts.sinceDate, aggressive: opts.aggressive,
      sig, runId: opts.runId ?? null,
    });
    return;
  }

  // Fallback item-a-item (Flash) quando não há seletor confiável.
  if (HAS_LLM) {
    const links = await extractLinksItemByItem(await cpuParse(() => pruneForLLM(capHtml(html))));
    let n = 0;
    for (const l of links) if (enqueue(l.url, childKind, url, source?.id, depth + 1)) n++;
    log(`fallback Flash: ${n} links (${childKind}) enfileirados de ${url}`);
  } else {
    warn(`sem OPENROUTER_API_KEY e sem seletor cacheado — não há como descobrir links em ${url}`);
  }
}

/** Pagina do arquivo até parar: página vazia, hash repetido, ou sem "próximo". */
async function crawlArchive(startUrl, source, sel, firstHtml, ctx) {
  const {
    childKind = 'article', baseDepth = 0, maxPages = Infinity, sinceDate = null,
    aggressive = false, sig = null, runId = null,
  } = ctx || {};
  const seenHashes = new Set();
  let pageUrl = startUrl;
  let html = firstHtml;
  let depth = 0;

  while (pageUrl && depth < maxPages) {
    if (html == null) html = (await fetchSmart(pageUrl, { profile: 'listing', aggressive })).html;

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

    // Com --since, pareia cada link à sua data (spec de data por IA cacheado -> <time> ->
    // fallbacks) p/ aplicar o piso já aqui e PARAR a paginação ao ver o 1º item abaixo do
    // piso (a lista do arquivo é decrescente).
    const dateSpec = sel?.date_selector || sel?.date_regex
      ? { date_selector: sel.date_selector, date_attribute: sel.date_attribute, date_regex: sel.date_regex }
      : null;
    let dated = sinceDate
      ? applyLinkSelectorWithDates(html, sel.link_selector, sel.link_attribute, pageUrl, dateSpec)
      : v.urls.map((u) => ({ url: u, date: null }));

    // Seletor de DATA por IA, lendo a página REAL: se o piso está ativo e nem o spec cacheado
    // nem os fallbacks genéricos dataram os itens, o Flash deriva um seletor CSS+regex
    // específico deste template de weekly; só cacheia se validar contra a própria página.
    if (sinceDate && HAS_LLM && dated.length >= 3 && !dated.some((it) => parseDate(it.date))) {
      try {
        const cand = await deriveDateSelector(await cpuParse(() => pruneForLLM(capHtml(html))), pageUrl);
        const spec = {
          date_selector: cand.date_selector || null,
          date_attribute: cand.date_attribute || null,
          date_regex: cand.date_regex || null,
        };
        if (spec.date_selector || spec.date_regex) {
          const trial = applyLinkSelectorWithDates(html, sel.link_selector, sel.link_attribute, pageUrl, spec);
          const good = trial.filter((it) => parseDate(it.date)).length;
          if (good >= Math.max(3, Math.ceil(trial.length * 0.5))) {
            const tsig = sig || domainSig(pageUrl, 'listing');
            sel = putSelector(tsig, spec);
            dated = trial;
            log(`date selector derivado p/ ${tsig}: css=${spec.date_selector || '—'} regex=${spec.date_regex || '—'} (${good}/${trial.length} itens datados)`);
            logEvent({
              runId, sourceId: source?.id ?? null, url: pageUrl,
              stage: 'dateSelector', status: 'ok', detail: { ...spec, dated: good, total: trial.length },
            });
          } else {
            warn(`date selector do Flash não validou (${good}/${trial.length} datados) — seguindo sem datas`);
            logEvent({
              runId, sourceId: source?.id ?? null, url: pageUrl,
              stage: 'dateSelector', status: 'invalid', detail: { ...spec, dated: good, total: trial.length },
            });
          }
        }
      } catch (e) {
        if (e?.code === 'BUDGET_EXCEEDED') throw e;
        warn(`deriveDateSelector falhou: ${e.message}`);
      }
    }
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
    logEvent({
      runId, sourceId: source?.id ?? null, url: pageUrl,
      stage: 'archive', status: 'ok',
      detail: { page: depth, links: dated.length, novos: added, abaixoDoPiso: below, childKind },
    });

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
    let next = null;
    try {
      next = await findNextPage(html, pageUrl, sel);
    } catch (e) {
      if (e?.code !== 'BUDGET_EXCEEDED') throw e;
      // Orçamento: o que já foi enfileirado nas páginas anteriores fica; só a paginação para.
      log(`paginação: orçamento atingido — encerrando o walk do arquivo em ${pageUrl}`);
      break;
    }
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
      if (e?.code === 'BUDGET_EXCEEDED') throw e; // crawlArchive encerra a paginação com log
      warn(`deriveNextLink falhou: ${e.message}`);
    }
  }
  return null;
}

// ---------------- ROUNDUP (issue/edição: lista de links externos curados) ----------------
async function processRoundup(job, source, opts = {}) {
  const url = job.url;
  const depth = job.depth ?? 0;
  const ev = { runId: opts.runId ?? null, sourceId: source?.id ?? null, url };
  if (!(await ensureAllowed(url, opts))) {
    logEvent({ ...ev, stage: 'roundup', status: 'skip', detail: { reason: 'robots' } });
    return;
  }

  const fetched = await fetchSmart(url, { profile: 'listing', aggressive: opts.aggressive }); // roundup é lista: rola/clica como listagem
  const finalUrl = fetched.url || url;
  logEvent({ ...ev, stage: 'fetch', status: 'ok', detail: { rendered: fetched.rendered === true } });

  // Piso por data da ISSUE (backstop autoritativo p/ itens do índice sem data legível). Como
  // descartamos a issue ANTES de enfileirar artigos, todo artigo enfileirado é de issue no piso.
  if (opts.sinceDate) {
    const d = parseDate(extractPublishedDate(fetched.html));
    if (d && d < opts.sinceDate) {
      log(`issue anterior a --since (${d.toISOString().slice(0, 10)}) ignorada: ${url}`);
      logEvent({ ...ev, stage: 'roundup', status: 'skip', detail: { reason: 'below-since' } });
      return;
    }
  }

  // Curadoria por IA (caminho principal): a issue vira ITENS estruturados cadastrados já aqui
  // (kind + blurb do agregador); o fetch de cada alvo vira enriquecimento. Ferramentas e
  // releases cuja informação só existe NO agregador deixam de se perder; patrocínio não entra.
  if (HAS_LLM && CURATE_ROUNDUPS) {
    try {
      const cur = await curateRoundup({
        html: fetched.html, url: finalUrl, source, runId: opts.runId ?? null, depth,
        sinceDate: opts.sinceDate,
      });
      if (cur?.belowFloor) {
        log(`issue anterior a --since (${cur.issueDate}) ignorada pela curadoria: ${url}`);
        return;
      }
      if (cur) {
        const kinds = Object.entries(cur.byKind).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ');
        const skipped = Object.entries(cur.skipped).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ');
        log(
          `roundup curado (${cur.chunks} chunk${cur.chunks > 1 ? 's' : ''}): ${cur.saved} itens novos ` +
            `(${kinds || '—'})${cur.recovered ? ` [${cur.recovered} do passe de cobertura]` : ''}` +
            `${cur.dup ? ` +${cur.dup} já conhecidos` : ''}` +
            `${skipped ? `, fora: ${skipped}` : ''} em ${url.slice(0, 80)}`,
        );
        return;
      }
      // cur == null: página sem corpo curável -> fluxo antigo de links abaixo
    } catch (e) {
      if (e?.code === 'BUDGET_EXCEEDED') throw e; // job volta a pending (retomável)
      warn(`curadoria falhou (${url}): ${e.message} — caindo p/ extração de links`);
      logEvent({ ...ev, stage: 'curate', status: 'fail', detail: { error: e.message } });
    }
  }

  const links = await roundupLinks(fetched.html, finalUrl);
  if (!links.length) {
    warn(`roundup sem links externos (nada enfileirado): ${url}`);
    logEvent({ ...ev, stage: 'roundup', status: 'skip', detail: { reason: 'no-links' } });
    return;
  }
  let n = 0;
  for (const l of links) if (enqueue(l.url, 'article', url, source?.id, depth + 1)) n++;
  log(`roundup: ${links.length} links externos (${n} novos) em ${url.slice(0, 80)}`);
  logEvent({ ...ev, stage: 'roundup', status: 'ok', detail: { links: links.length, novos: n, curated: false } });
}

// ---------------- ARTICLE ----------------
/** Item curado cujo alvo não rendeu corpo: o registro FICA com o blurb do agregador. */
function keepAggregatorVersion(row, ev, reason) {
  stmts.finishEnrich.run(row.id);
  logEvent({ ...ev, stage: 'enrich', status: 'kept-blurb', detail: { reason } });
  log(`item mantido com o blurb do agregador (${reason}): ${(row.title || row.url).slice(0, 70)}`);
}

async function processArticle(job, source, opts) {
  const url = job.url;
  const depth = job.depth ?? 0;
  const ev = { runId: opts.runId ?? null, sourceId: source?.id ?? null, url };

  // Item curado aguardando corpo (needs_enrich=1)? Senão, dedup normal por URL.
  const jobNorm = normalizeUrl(url) || url;
  const pre = stmts.getArticleFullByUrl.get(jobNorm);
  const enriching = pre && pre.needs_enrich ? pre : null;
  if (pre && !enriching) {
    log(`artigo já existe (url canônica) ignorado: ${url}`);
    return;
  }

  if (!(await ensureAllowed(url, opts))) {
    if (enriching) keepAggregatorVersion(enriching, ev, 'robots');
    else logEvent({ ...ev, stage: 'article', status: 'skip', detail: { reason: 'robots' } });
    return;
  }

  let fetched;
  try {
    fetched = await fetchSmart(url, { profile: 'article', aggressive: opts.aggressive }); // sem load-more; scroll e deadline curtos
  } catch (e) {
    // Falha de fetch pode ser transitória: deixa o retry do job agir (needs_enrich continua 1;
    // esgotados os retries, o registro curado segue válido com o blurb e o inspect mostra o porquê).
    logEvent({ ...ev, stage: 'fetch', status: 'fail', detail: { error: e.message, enrich: Boolean(enriching) } });
    throw e;
  }
  const html = fetched.html;
  const finalUrl = fetched.url || url;
  logEvent({ ...ev, stage: 'fetch', status: 'ok', detail: { rendered: fetched.rendered === true } });

  // Identidade canônica pós-redirect: dedup mesmo quando A->B (alias de redirect). Checa ANTES
  // de extrair — não cadastra 2x o mesmo link e economiza extração/LLM. (content_hash é backstop.)
  const canonicalUrl = normalizeUrl(finalUrl) || jobNorm;
  if (!enriching && stmts.getArticleByUrl.get(canonicalUrl)) {
    log(`artigo já existe (url canônica) ignorado: ${url}`);
    logEvent({ ...ev, stage: 'article', status: 'skip', detail: { reason: 'dup-url', canonicalUrl } });
    return;
  }

  let title = null;
  let content = null;
  let published = null;
  let method = null;

  // 1) Readability (uma vez; reaproveitado p/ roundup-detection e p/ extração do corpo).
  const art = await cpuParse(() => extractArticle(capHtml(html), finalUrl));

  // Roundup-detection: às vezes um "link" aponta p/ uma página que é uma COLEÇÃO de várias
  // notícias. NUNCA p/ item curado (o item é UM registro — um repo GitHub tem dezenas de links
  // e pouca prosa; dividir destruiria a ferramenta). Só dividimos quando a página é
  // PREDOMINANTEMENTE uma lista de links (pouca prosa) e o nº de links externos está numa
  // faixa "de roundup". Limitado por MAX_CRAWL_DEPTH p/ não recursar sem fim.
  if (!enriching && depth < MAX_CRAWL_DEPTH && art?.content) {
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
      logEvent({ ...ev, stage: 'article', status: 'split', detail: { links: ext.length, proseLen, enfileirados: n } });
      return;
    }
  }

  if (art?.textContent && art.textContent.trim().length >= 400) {
    title = art.title;
    content = art.textContent.trim();
    published = art.publishedTime || null;
    method = 'readability';
  } else {
    // 2) Seletor de conteúdo (cacheado ou derivado uma vez via Pro).
    const sig = domainSig(url, 'article');
    let csel = getCachedSelector(sig);
    if (!csel?.content_selector && HAS_LLM) {
      try {
        const cand = await deriveContentSelector(await cpuParse(() => pruneForLLM(capHtml(html))));
        if (validateContentSelector(html, cand.content_selector).ok) {
          csel = putSelector(sig, {
            content_selector: cand.content_selector,
            model_used: 'deepseek-v4-pro',
            confidence: cand.confidence,
          });
          log(`content selector derivado p/ ${sig}: "${cand.content_selector}"`);
        }
      } catch (e) {
        // Orçamento: o próximo passo (extração via LLM) também seria negado — rethrow.
        if (e?.code === 'BUDGET_EXCEEDED') throw e;
        warn(`deriveContentSelector falhou: ${e.message}`);
      }
    }
    if (csel?.content_selector) {
      const v = validateContentSelector(html, csel.content_selector);
      if (v.ok) {
        content = v.result.text;
        method = 'content-selector';
      }
    }
    // 3) Fallback final: extração direta via LLM (Flash).
    if (!content && HAS_LLM) {
      try {
        const out = await extractArticleViaLLM(await cpuParse(() => pruneForLLM(capHtml(html))));
        title = out.title;
        content = out.content;
        published = out.published_at;
        method = 'llm';
      } catch (e) {
        // Orçamento: sem o fallback LLM não há conteúdo — rethrow p/ o artigo seguir pending.
        if (e?.code === 'BUDGET_EXCEEDED') throw e;
        warn(`extractArticleViaLLM falhou: ${e.message}`);
      }
    }
    if (!title) title = fallbackTitle(html) || url;
  }

  if (!content || content.length < 50) {
    if (enriching) return keepAggregatorVersion(enriching, ev, 'thin-content');
    warn(`sem conteúdo extraível em ${url}`);
    logEvent({ ...ev, stage: 'article', status: 'skip', detail: { reason: 'no-content' } });
    return;
  }

  // Descarta interstitials anti-bot (Cloudflare "Just a moment...", captcha) — vêm com 200 mas
  // não são artigo. Item curado mantém o blurb (a página de desafio nunca vira conteúdo).
  if (isBlockedPage(title, content)) {
    if (enriching) return keepAggregatorVersion(enriching, ev, 'blocked-page');
    warn(`página anti-bot/bloqueada ignorada (sem artigo real): ${url}`);
    logEvent({ ...ev, stage: 'article', status: 'skip', detail: { reason: 'blocked-page' } });
    return;
  }

  // Piso por data do ARTIGO: descarta artigo AVULSO com data própria anterior ao piso. Item
  // curado NÃO é censurado pelo piso — ele pertence à issue (em range); a âncora temporal do
  // registro é a data da issue, e a data própria do alvo fica no trace.
  if (opts.sinceDate && !enriching) {
    const d = parseDate(published);
    if (d && d < opts.sinceDate) {
      log(`artigo anterior a --since (${published}) ignorado: ${url}`);
      logEvent({ ...ev, stage: 'article', status: 'skip', detail: { reason: 'below-since', published } });
      return;
    }
  }

  // Limpeza por IA antes de salvar (Flash): o modelo devolve SPANS de sujeira (verbatim) e a
  // remoção é local (applyJunkSpans) — saída pequena (rápida) e sem risco de reescrita; a
  // guarda anti over-deletion mantém o original quando a remoção fica implausível.
  let cleaned = 0;
  if (HAS_LLM && CLEAN_BEFORE_SAVE) {
    const head = content.slice(0, CLEAN_MAX_CHARS);
    const tail = content.length > CLEAN_MAX_CHARS ? content.slice(CLEAN_MAX_CHARS) : '';
    try {
      const out = await cleanArticleContent({ title: title || enriching?.title, content: head });
      cleaned = 1;
      const res = applyJunkSpans(head, out.junk_spans);
      if (res.rejected) {
        logEvent({ ...ev, stage: 'clean', status: 'reject', detail: { reason: res.reason, spans: out.junk_spans.length } });
        warn(`limpeza IA rejeitada (${res.reason}) — mantendo original: ${url.slice(0, 60)}`);
      } else if (res.applied > 0) {
        content = res.text + tail;
        logEvent({
          ...ev, stage: 'clean', status: 'ok',
          detail: { spans: res.applied, ignorados: res.notFound, removidos: res.removed, truncado: Boolean(tail) },
        });
      } else {
        logEvent({ ...ev, stage: 'clean', status: 'ok', detail: { jaLimpo: true, ignorados: res.notFound } });
      }
      if (!enriching && out.title) title = out.title;
      if (!published && out.published_at) published = out.published_at;
    } catch (e) {
      if (e?.code === 'BUDGET_EXCEEDED') throw e;
      warn(`limpeza IA falhou (${url}): ${e.message} — salvando original`);
      logEvent({ ...ev, stage: 'clean', status: 'fail', detail: { error: e.message } });
    }
  }

  const contentHash = sha256(content);
  const dupHash = stmts.getArticleByHash.get(contentHash);
  if (dupHash && (!enriching || dupHash.id !== enriching.id)) {
    if (enriching) return keepAggregatorVersion(enriching, ev, 'dup-content');
    log(`artigo duplicado (hash) ignorado: ${url}`);
    logEvent({ ...ev, stage: 'article', status: 'skip', detail: { reason: 'dup-hash' } });
    return;
  }

  if (enriching) {
    // Título curado é autoritativo (o agregador nomeia melhor: "Node-GTK 4.0" e não
    // "The GTK Project - …"); a data-âncora (da issue) só é preenchida se estava vazia.
    stmts.enrichArticle.run({
      id: enriching.id,
      title: enriching.title || title || canonicalUrl,
      content,
      content_hash: contentHash,
      published_at: enriching.published_at || published || null,
      content_source: 'target',
      cleaned,
    });
    logEvent({
      ...ev, stage: 'enrich', status: 'ok',
      detail: { method, chars: content.length, cleaned: Boolean(cleaned), targetDate: published || null },
    });
    log(`item enriquecido [${enriching.kind || 'news'}]: ${(enriching.title || canonicalUrl).slice(0, 70)}`);
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
    kind: null,
    issue_url: job.discovered_from || null,
    section: null,
    blurb: null,
    content_source: 'target',
    cleaned,
    needs_enrich: 0,
  });
  logEvent({ ...ev, stage: 'save', status: 'ok', detail: { method, chars: content.length, cleaned: Boolean(cleaned) } });
  log(`artigo salvo: ${(title || canonicalUrl).slice(0, 80)}`);
}
