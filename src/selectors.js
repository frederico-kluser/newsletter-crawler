// Cache de seletores (SQLite) + aplicação/validação com Cheerio (self-healing).
import * as cheerio from 'cheerio';
import { stmts } from './db.js';
import { normalizeUrl } from './util.js';

export function getCachedSelector(templateSig) {
  return stmts.getSelector.get(templateSig) || null;
}

export function putSelector(templateSig, fields) {
  // Mescla com o que já existe para não apagar colunas não informadas.
  const prev = getCachedSelector(templateSig) || {};
  stmts.putSelector.run({
    template_sig: templateSig,
    link_selector: fields.link_selector ?? prev.link_selector ?? null,
    link_attribute: fields.link_attribute ?? prev.link_attribute ?? null,
    content_selector: fields.content_selector ?? prev.content_selector ?? null,
    next_selector: fields.next_selector ?? prev.next_selector ?? null,
    model_used: fields.model_used ?? prev.model_used ?? null,
    confidence: fields.confidence ?? prev.confidence ?? null,
  });
  return getCachedSelector(templateSig);
}

/** Aplica um seletor de links e devolve URLs absolutas/normalizadas e únicas. */
export function applyLinkSelector(html, selector, attribute = 'href', baseUrl) {
  const $ = cheerio.load(html);
  const urls = [];
  $(selector).each((_, el) => {
    const v = $(el).attr(attribute) || $(el).attr('href');
    const abs = v ? normalizeUrl(v, baseUrl) : null;
    if (abs) urls.push(abs);
  });
  return [...new Set(urls)];
}

/**
 * Como applyLinkSelector, mas pareia cada link com a data do item (string crua de
 * <time datetime>), usada p/ a parada por data na paginação do índice. Procura o <time>
 * como DESCENDENTE do <a> (layout aiweekly) e, como fallback, dentro do <li> ancestral
 * (layouts em que a data é irmã do link). Dedup por URL.
 */
export function applyLinkSelectorWithDates(html, selector, attribute = 'href', baseUrl) {
  const $ = cheerio.load(html);
  const out = new Map();
  $(selector).each((_, el) => {
    const v = $(el).attr(attribute) || $(el).attr('href');
    const abs = v ? normalizeUrl(v, baseUrl) : null;
    if (!abs || out.has(abs)) return;
    const date =
      $(el).find('time[datetime]').first().attr('datetime') ||
      $(el).closest('li').find('time[datetime]').first().attr('datetime') ||
      null;
    out.set(abs, { url: abs, date: date ? date.trim() : null });
  });
  return [...out.values()];
}

export function validateLinkSelector(html, selector, attribute, baseUrl, { min = 3 } = {}) {
  let urls = [];
  try {
    urls = applyLinkSelector(html, selector, attribute, baseUrl);
  } catch {
    urls = [];
  }
  return { ok: urls.length >= min, count: urls.length, urls };
}

/** Extrai texto do container apontado por um seletor de conteúdo. */
export function applyContentSelector(html, selector) {
  try {
    const $ = cheerio.load(html);
    const node = $(selector).first();
    if (!node || node.length === 0) return null;
    return { text: node.text().replace(/\s+/g, ' ').trim(), html: node.html() || '' };
  } catch {
    return null;
  }
}

export function validateContentSelector(html, selector, { minLen = 400 } = {}) {
  const result = applyContentSelector(html, selector);
  return { ok: Boolean(result && result.text && result.text.length >= minLen), result };
}
