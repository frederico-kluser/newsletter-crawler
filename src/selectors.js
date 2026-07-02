// Cache de seletores (SQLite) + aplicação/validação com Cheerio (self-healing).
import * as cheerio from 'cheerio';
import { stmts } from './db.js';
import { normalizeUrl, parseDate } from './util.js';

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
    date_selector: fields.date_selector ?? prev.date_selector ?? null,
    date_attribute: fields.date_attribute ?? prev.date_attribute ?? null,
    date_regex: fields.date_regex ?? prev.date_regex ?? null,
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

// Data textual em formato estrito (ISO, "June 18, 2026", "18 June 2026"). Estrita de
// propósito: o fallback por container NÃO pode transformar números soltos em data.
const TEXT_DATE_RE = new RegExp(
  '\\b\\d{4}-\\d{2}-\\d{2}\\b' +
    '|\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b' +
    '|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{4}\\b',
  'i',
);

/** Valida um candidato textual: só retorna se casa o padrão estrito E parseia como Date. */
function validDateText(cand) {
  const m = String(cand || '').match(TEXT_DATE_RE);
  return m && parseDate(m[0]) ? m[0].trim() : null;
}

/**
 * Aplica o SPEC de data derivado por IA ({date_selector, date_attribute, date_regex}) a um
 * item: procura o seletor CSS dentro do link e subindo até 4 ancestrais (containers de item
 * variam por layout); o valor vem do atributo indicado (ou datetime/content/texto) e passa
 * pela regex (grupo 1 ou match inteiro). Sem seletor, a regex roda no texto do container.
 * Tudo validado por parseDate — spec ruim degrada p/ null, nunca p/ data inventada.
 */
function dateFromSpec($, el, spec) {
  if (!spec || (!spec.date_selector && !spec.date_regex)) return null;
  let re = null;
  if (spec.date_regex) {
    try {
      re = new RegExp(spec.date_regex, 'i');
    } catch {
      re = null; // regex inválida do LLM: segue só com o seletor CSS
    }
  }
  const pick = (raw) => {
    if (raw == null) return null;
    const s = String(raw).replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!s) return null;
    if (re) {
      try {
        const m = s.match(re);
        if (!m) return null;
        const cand = (m[1] ?? m[0]).trim();
        return parseDate(cand) ? cand : null;
      } catch {
        return null;
      }
    }
    return parseDate(s) ? s : null;
  };

  if (spec.date_selector) {
    let scope = $(el);
    for (let up = 0; up < 4 && scope.length; up++, scope = scope.parent()) {
      let hit;
      try {
        hit = scope.find(spec.date_selector).first();
      } catch {
        return null; // seletor CSS inválido do LLM
      }
      if (hit.length) {
        const raw =
          (spec.date_attribute && hit.attr(spec.date_attribute)) ||
          hit.attr('datetime') ||
          hit.attr('content') ||
          hit.text();
        return pick(raw); // achou o elemento: não sobe mais (evita pegar a data de outro item)
      }
    }
    return null;
  }
  const container = $(el).closest('li, tr, article, div');
  return container.length ? pick(container.text()) : null;
}

/**
 * Data do ITEM de listagem em volta de um <a>: 1º o SPEC derivado por IA p/ este template
 * (CSS+regex, cacheado em selectors) -> <time datetime> descendente do link ou do <li>
 * ancestral (layout aiweekly) -> elemento com classe contendo "date" no container do item
 * (ex.: <span class="issue-date">2026-07-02</span> do nodeweekly) -> regex estrita no texto
 * curto do container. Retorna a STRING crua (parsing fica em util.parseDate) ou null.
 */
export function dateNearLink($, el, spec = null) {
  const fromSpec = dateFromSpec($, el, spec);
  if (fromSpec) return fromSpec;
  const $el = $(el);
  const t =
    $el.find('time[datetime]').first().attr('datetime') ||
    $el.closest('li').find('time[datetime]').first().attr('datetime');
  if (t) return t.trim();

  const container = $el.closest('li, tr, article, div');
  if (!container.length) return null;

  const dEl = container.find('[class*="date"]').first();
  if (dEl.length) {
    // Atributos de data primeiro (datetime/content costumam ser ISO), depois o texto.
    for (const cand of [dEl.attr('datetime'), dEl.attr('content'), dEl.text()]) {
      const ok = validDateText(cand);
      if (ok) return ok;
    }
  }

  // Container curto = um item de listagem (não um parágrafo): regex estrita no texto.
  const txt = container.text().replace(/\s+/g, ' ').trim();
  if (txt.length <= 300) return validDateText(txt);
  return null;
}

/**
 * Como applyLinkSelector, mas pareia cada link com a data do item (string crua), usada p/ a
 * parada por data na paginação do índice. `dateSpec` é o seletor de data derivado por IA p/
 * este template ({date_selector, date_attribute, date_regex}); ver dateNearLink p/ a cadeia
 * de fallbacks (nem toda listagem usa <time datetime> — o nodeweekly usa
 * <span class="issue-date">). Dedup por URL.
 */
export function applyLinkSelectorWithDates(html, selector, attribute = 'href', baseUrl, dateSpec = null) {
  const $ = cheerio.load(html);
  const out = new Map();
  $(selector).each((_, el) => {
    const v = $(el).attr(attribute) || $(el).attr('href');
    const abs = v ? normalizeUrl(v, baseUrl) : null;
    if (!abs || out.has(abs)) return;
    out.set(abs, { url: abs, date: dateNearLink($, el, dateSpec) });
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
    $('script, style, noscript, template').remove(); // .text() suga o CÓDIGO-FONTE de script/style
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
