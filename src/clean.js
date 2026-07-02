// Limpeza/extração: poda de DOM para LLM, extração de artigo (Readability), HTML->Markdown.
import { JSDOM } from 'jsdom';
import { Readability, isProbablyReaderable } from '@mozilla/readability';
import TurndownService from 'turndown';
import * as cheerio from 'cheerio';
import { MAX_HTML_FOR_LLM } from './config.js';
import { getLane } from './governor.js';
import { debug } from './util.js';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

// Lane de CPU p/ parses SÍNCRONOS (JSDOM/Readability/prune, 50ms–5s cada): limita o DÉBITO
// agregado de latência no event loop (timers do governador, CDP) — não a latência de um parse.
// O setImmediate cede o loop antes do bloco síncrono; HTML gigante é truncado (fail-open)
// antes do JSDOM p/ um outlier não segurar o processo por dezenas de segundos.
// (Morava em crawl.js; vive aqui p/ crawl.js E curate.js usarem sem ciclo de import.)
const MAX_PARSE_HTML = 2 * 1024 * 1024;
export const capHtml = (html) => {
  if (html && html.length > MAX_PARSE_HTML) {
    debug(`parse: HTML de ${html.length} chars truncado em ${MAX_PARSE_HTML}`);
    return html.slice(0, MAX_PARSE_HTML);
  }
  return html;
};
export async function cpuParse(fn) {
  return getLane('cpu')(async () => {
    await new Promise((r) => setImmediate(r));
    return fn();
  });
}

/**
 * Aplica os junk_spans da limpeza por IA: remove do texto TODAS as ocorrências exatas de cada
 * span (dedup, maiores primeiro; span não encontrado verbatim é ignorado — fail-open). A
 * remoção nunca reescreve: só deleta. sanityCheckCleaned guarda contra over-deletion (se o
 * resultado ficar implausivelmente pequeno, mantém o original). Puro/testável.
 */
export function applyJunkSpans(original, spans) {
  const o = String(original || '');
  const uniq = [...new Set((spans || []).map((s) => String(s || '')).filter((s) => s.trim().length >= 4))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 60);
  let text = o;
  let applied = 0;
  let notFound = 0;
  for (const span of uniq) {
    if (text.includes(span)) {
      text = text.split(span).join(' ');
      applied++;
    } else {
      notFound++;
    }
  }
  if (!applied) return { text: o, applied: 0, notFound, removed: 0, rejected: false };
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const check = sanityCheckCleaned(o, text);
  if (!check.ok) {
    // Removeu demais p/ ser só sujeira: conservador, mantém o original (verify julga depois).
    return { text: o, applied: 0, notFound, removed: 0, rejected: true, reason: check.reason };
  }
  return { text, applied, notFound, removed: o.length - text.length, rejected: false };
}

/**
 * Sanidade da limpeza por IA (anti-alucinação/truncamento): o texto limpo precisa ser um
 * recorte plausível do original — nem minúsculo (truncou), nem maior (inventou). Puro/testável.
 */
export function sanityCheckCleaned(original, cleaned) {
  const o = String(original || '').trim();
  const c = String(cleaned || '').trim();
  if (!c) return { ok: false, reason: 'vazio' };
  // Piso anti-truncamento: em texto longo, >= max(200, 15%); em texto curto, o teto de 60%
  // do original governa (limpar um blurb de 80 chars pode legitimamente tirar um pedaço).
  const min = Math.floor(Math.min(Math.max(200, o.length * 0.15), o.length * 0.6));
  if (c.length < min) return { ok: false, reason: `curto demais (${c.length} < ${min})` };
  if (c.length > o.length * 1.2 + 500) return { ok: false, reason: 'maior que o original' };
  return { ok: true };
}

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
