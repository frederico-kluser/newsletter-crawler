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

/** Título de fallback a partir de <h1>/<title>. */
export function fallbackTitle(html) {
  try {
    const $ = cheerio.load(html);
    return ($('h1').first().text() || $('title').text() || '').trim();
  } catch {
    return '';
  }
}
