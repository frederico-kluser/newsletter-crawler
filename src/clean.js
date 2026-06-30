// Limpeza/extração: poda de DOM para LLM, extração de artigo (Readability), HTML->Markdown.
import { JSDOM } from 'jsdom';
import { Readability, isProbablyReaderable } from '@mozilla/readability';
import TurndownService from 'turndown';
import * as cheerio from 'cheerio';
import { MAX_HTML_FOR_LLM } from './config.js';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

/** Extrai o corpo do artigo com o algoritmo do Reader View. Retorna objeto ou null. */
export function extractArticle(html, url) {
  let dom;
  try {
    dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    return reader.parse(); // { title, byline, content, textContent, excerpt, publishedTime, siteName } | null
  } catch {
    return null;
  } finally {
    dom?.window?.close?.();
  }
}

/** <a href> de um fragmento HTML como {url,title} absolutos. Defensivo (nunca lança). */
export function linksInHtml(fragmentHtml, baseUrl) {
  const out = [];
  try {
    const $ = cheerio.load(fragmentHtml || '');
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      let abs;
      try {
        abs = new URL(href, baseUrl).href;
      } catch {
        return;
      }
      out.push({ url: abs, title: $(el).text().replace(/\s+/g, ' ').trim() });
    });
  } catch {
    /* fail-open */
  }
  return out;
}

/**
 * Links do CORPO que o Readability isola (já sem nav/header/footer/sponsor). É a base da
 * extração de roundup/issue: os <a> aqui são os links curados das notícias. Retorna
 * { title, textLen, links:[{url,title}] } com URLs absolutas (resolvidas contra `url`).
 */
export function readableLinks(html, url) {
  const art = extractArticle(html, url);
  return {
    title: art?.title || null,
    textLen: art?.textContent?.trim().length || 0,
    links: art?.content ? linksInHtml(art.content, url) : [],
  };
}

/** Heurística do Readability: a página parece um artigo legível? */
export function probablyArticle(html, url) {
  let dom;
  try {
    dom = new JSDOM(html, { url });
    return isProbablyReaderable(dom.window.document);
  } catch {
    return false;
  } finally {
    dom?.window?.close?.();
  }
}

/**
 * Poda o DOM para reduzir tokens antes de enviar ao LLM (método HtmlRAG):
 * remove script/style/etc. e mantém só atributos úteis para seletores.
 */
export function pruneForLLM(html, { maxLen = MAX_HTML_FOR_LLM } = {}) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, link, meta, head, nav, footer, aside, form, template').remove();
  const keep = new Set(['href', 'class', 'id']);
  $('*').each((_, el) => {
    if (el.type !== 'tag' || !el.attribs) return;
    for (const attr of Object.keys(el.attribs)) {
      if (!keep.has(attr)) $(el).removeAttr(attr);
    }
  });
  const body = $('body').html() || $.html() || '';
  return body.length > maxLen ? body.slice(0, maxLen) : body;
}

export function htmlToMarkdown(html) {
  try {
    return turndown.turndown(html || '');
  } catch {
    return '';
  }
}

// Páginas de bloqueio/desafio anti-bot (Cloudflare etc.) que vêm com status 200 mas sem
// conteúdo real — não devem virar "artigo". Detecta pelo título/início do corpo.
const BLOCKED_PATTERNS = [
  /just a moment/i,
  /attention required/i,
  /verify(?:ing)? (?:that )?you(?:'| a)?re (?:a )?human/i,
  /enable javascript and cookies/i,
  /please enable (?:js|javascript|cookies)/i,
  /checking your browser/i,
  /are you a robot/i,
  /\bcaptcha\b/i,
  /access denied/i,
  /ddos protection by/i,
  /cf-browser-verification/i,
  /performing security verification/i,
  /checking if the site connection is secure/i,
];

/** A página parece um interstitial anti-bot (Cloudflare etc.) em vez de um artigo? */
export function isBlockedPage(title, text) {
  const hay = `${title || ''}\n${(text || '').slice(0, 600)}`;
  return BLOCKED_PATTERNS.some((re) => re.test(hay));
}

// Acha recursivamente um `datePublished` em JSON-LD (que costuma vir aninhado em @graph).
// Checa datePublished explicitamente ANTES de descer, p/ nunca confundir com dateModified.
function findDatePublished(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const x of node) {
      const r = findDatePublished(x);
      if (r) return r;
    }
    return null;
  }
  if (typeof node.datePublished === 'string') return node.datePublished;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') {
      const r = findDatePublished(v);
      if (r) return r;
    }
  }
  return null;
}

/**
 * Data de publicação a partir do HTML (a issue/edição expõe isso de forma confiável):
 * JSON-LD `datePublished` (inclusive dentro de @graph) -> <meta article:published_time> ->
 * primeiro <time datetime>. Retorna a STRING crua (o parsing fica em util.parseDate).
 */
export function extractPublishedDate(html) {
  try {
    const $ = cheerio.load(html);
    let found = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      if (found) return;
      try {
        found = findDatePublished(JSON.parse($(el).text()));
      } catch {
        /* JSON-LD malformado: ignora */
      }
    });
    if (found) return String(found).trim();
    const meta =
      $('meta[property="article:published_time"]').attr('content') ||
      $('meta[name="article:published_time"]').attr('content');
    if (meta) return meta.trim();
    const t = $('time[datetime]').first().attr('datetime');
    if (t) return t.trim();
  } catch {
    /* fail-open */
  }
  return null;
}

/** Título de fallback a partir de <h1>/<title>. */
export function fallbackTitle(html) {
  try {
    const $ = cheerio.load(html);
    return ($('h1').first().text() || $('title').text() || '').trim();
  } catch {
    return '';
  }
}
