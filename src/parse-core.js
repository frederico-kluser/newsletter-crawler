// Núcleo de parsing (JSDOM/Readability/cheerio/turndown) — SEM dependências de db/governor/
// fetch, para poder rodar DENTRO de um worker thread (src/parse-worker.js). As funções JSDOM
// (extractArticle/readableLinks/probablyArticle) são as que causaram o SIGSEGV nativo raro do
// parser de CSS do JSDOM; isolá-las num worker faz um crash matar SÓ o worker, não o processo.
// As demais (cheerio/turndown/puras) são leves e seguras — rodam no processo principal.
import { JSDOM } from 'jsdom';
import { Readability, isProbablyReaderable } from '@mozilla/readability';
import TurndownService from 'turndown';
import * as cheerio from 'cheerio';
import { MAX_HTML_FOR_LLM } from './config.js';
import { debug } from './util.js';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

// HTML gigante é truncado (fail-open) antes do JSDOM p/ um outlier não segurar um worker por
// dezenas de segundos (o pool ainda tem timeout por task como backstop).
const MAX_PARSE_HTML = 2 * 1024 * 1024;
export const capHtml = (html) => {
  if (html && html.length > MAX_PARSE_HTML) {
    debug(`parse: HTML de ${html.length} chars truncado em ${MAX_PARSE_HTML}`);
    return html.slice(0, MAX_PARSE_HTML);
  }
  return html;
};

// ---- ops JSDOM (rodam no worker; retorno é sempre DADO serializável entre threads) ----

/** Extrai o corpo do artigo com o algoritmo do Reader View. Retorna objeto (strings) ou null. */
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

// ---- ops cheerio/puras (leves, seguras; rodam no processo principal) ----

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

// ---- guarda de TEXTO PURO no armazenamento (anti "HTML cru" nas fichas) ----
// A extração já devolve texto (Readability .textContent, cheerio .text()), mas o fallback por
// LLM e o blurb do agregador podem ecoar marcação. ensurePlainText é a rede final: converte
// SÓ quando a string é HTML de verdade — nunca mexe em prosa/código com "<" solto (a < b,
// Array<T>, um "<div>" citado). Precisão > recall de propósito.
const ATTR_TAG_RE = /<[a-z][\w-]*\s+[a-z][\w-]*\s*=/i; // <a href=, <img src=, <div class=
const CLOSE_TAG_RE = /<\/[a-z][\w-]*\s*>/gi; // </p>, </strong>, </div>
const ENTITY_RE = /&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/i;
const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * A string É markup HTML? Dispara com tag-com-atributo OU qualquer </tag> de fechamento. Prosa
 * com "<" solto (a < b, Array<T>, um "<div>" citado só na ABERTURA) não tem fechamento => passa
 * intacta; um blurb de UMA linha "<p>…</p>" (o caso das notícias) já dispara. Puro/testável.
 */
export function looksLikeHtml(s) {
  const str = String(s || '');
  if (!str) return false;
  if (ATTR_TAG_RE.test(str)) return true; // atributo => HTML real
  return Boolean(str.match(CLOSE_TAG_RE)); // qualquer </tag> => markup real (match, não test: /g é stateful)
}

// Decodifica um conjunto CONHECIDO de entidades sem tocar em "<" cru (preserva a < b, Array<T>).
function decodeEntities(s) {
  return String(s)
    .replace(/&(?:([a-z]+)|#(\d+)|#x([0-9a-f]+));/gi, (m, name, dec, hex) => {
      if (name) {
        const k = name.toLowerCase();
        return k in ENTITY_MAP ? ENTITY_MAP[k] : m;
      }
      const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return m;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return m;
      }
    })
    .replace(/ /g, ' ');
}

// Converte um fragmento HTML em texto: cheerio já decodifica entidades; matamos ruído JS/CSS e
// marcamos fronteiras de bloco p/ não colar palavras. Fail-open com strip por regex.
function htmlFragmentToText(html) {
  try {
    const $ = cheerio.load(html);
    $('script, style, noscript, template, svg, head').remove();
    $('br').replaceWith(' ');
    $('p, div, li, tr, section, article, blockquote, h1, h2, h3, h4, h5, h6, ul, ol, table, pre').append(' ');
    const text = $('body').text() || $.root().text() || '';
    return text
      .replace(/ /g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  }
}

/** Garante TEXTO limpo: converte só quando é markup HTML; senão devolve intacto. Puro/testável. */
export function ensurePlainText(s) {
  const str = String(s ?? '');
  if (!str.trim()) return str;
  if (looksLikeHtml(str)) return htmlFragmentToText(str); // tags reais: tira tags + decodifica
  if (ENTITY_RE.test(str)) return decodeEntities(str); // só entidades: decodifica preservando "<T>"
  return str; // texto puro / markdown / código: intacto
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
 * primeiro <time datetime> -> atributos data-* comuns -> TEXTO VISÍVEL com mês por extenso
 * (ex.: "August 13, 2026" — nodeweekly não expõe a data em nenhum atributo, só no texto).
 * Retorna a STRING crua (o parsing fica em util.parseDate); o ordinal do dia (13th) é
 * removido porque o parse nativo de Date não o entende.
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
    // Fallback adicional: atributos data-* comuns (alguns CMS só expõem a data em data-*)
    const $dateEl = $('[data-date], [data-published], [data-publish-date], [data-post-date]').first();
    const dataAttr =
      $dateEl.attr('data-date') ||
      $dateEl.attr('data-published') ||
      $dateEl.attr('data-publish-date') ||
      $dateEl.attr('data-post-date');
    if (dataAttr) return dataAttr.trim();
    // Fallback FINAL por TEXTO VISÍVEL: semanais sem meta (caso real: nodeweekly/issues/637
    // tem SÓ "August 13, 2026" no corpo). Mês por extenso + dia + ano; o 1º match do body
    // costuma ser o cabeçalho da própria issue. parseDate entende o formato cru.
    // Clone + espaço após elementos de bloco: o .text() do cheerio cola elementos vizinhos
    // ("637August"), o que quebraria o \b do regex em fronteiras de elemento.
    const $body = $('body').clone();
    $body.find('script, style, noscript, template, svg').remove();
    $body
      .find('br, p, div, li, tr, section, article, blockquote, h1, h2, h3, h4, h5, h6, ul, ol, table, pre')
      .append(' ');
    // Ano restrito a uma janela segura (corrente ± 1): prosa citando "May 4, 2019" não pode
    // ancorar a issue num ano velho — clampFutureDate só pega FUTURO, e um ano abaixo do piso
    // --since faria o item ser DESCARTADO (pior que NULL). Dia aceita ordinal opcional
    // ("August 13th, 2026"), com ou sem vírgula antes do ano. RegExp dinâmico pelo ano.
    const y = new Date().getFullYear();
    const textMatch = $body.text().match(
      new RegExp(
        '\\b(?:January|February|March|April|May|June|July|August|September|October|November|December)' +
          `\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+(?:${y - 2}|${y - 1}|${y}|${y + 1})\\b`,
        'i',
      ),
    );
    // parseDate (Date nativo) não entende ordinal — devolve o texto SEM o sufixo (13th -> 13)
    // p/ a data virar âncora de verdade (iso_date/parseDate) e não cair no fallback extracted_at.
    if (textMatch) return textMatch[0].replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/i, '$1');
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

// ---- P6a: quebras de linha entre blocos (o textContent do Readability cola blocos) ----
// O .textContent do JSDOM concatena os text nodes SEM separador: em HTML minificado (sem
// newline entre elementos), parágrafos/cabeçalhos/li ficam colados ("h1 colado ao parágrafo" —
// casos TermDOM/DeepSeek da captura 2026-08-14). A correção é SÓ inserir '\n' nas fronteiras
// de bloco — nenhuma outra normalização de conteúdo (palavras intocadas).
const BLOCK_BOUNDARY_SEL =
  'p, div, li, h1, h2, h3, h4, h5, h6, pre, blockquote, ul, ol, table, tr, section, article';

/**
 * Texto de um fragmento HTML com '\n' entre fronteiras de bloco (p/div/li/h1-6/pre/blockquote/
 * ul/ol/table; `<br>` vira '\n'). Falha -> null (o chamador cai no textContent). Puro/testável.
 */
export function blockTextFromHtml(html) {
  try {
    const $ = cheerio.load(html || '');
    $('script, style, noscript, template, svg, head').remove();
    $('br').replaceWith('\n');
    $(BLOCK_BOUNDARY_SEL).append('\n');
    const text = $('body').text() || $.root().text() || '';
    // \n{3,} só pode ter nascido das fronteiras aninhadas (ul>li>div etc.): colapsa em \n\n.
    return text.replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    return null; // fail-open: quem chama decide
  }
}

/** Conteúdo do Readability com quebras de bloco; falha -> textContent atual (fail-open). */
export function htmlBlockText(art) {
  if (art?.content) {
    const t = blockTextFromHtml(art.content);
    if (t) return t;
  }
  return art?.textContent?.trim() || '';
}

// ---- P5: fim truncado por botão de UI (release notes do GitHub etc.) ----
// A captura 2026-08-14 (Node Weekly): a release do Vitest terminava em "View changes on GitHub"
// — o botão de UI que fecha o corpo da release no GitHub. O corpo extraído pode terminar num
// gatilho desses (botão de expansão/atalho), o que parece truncamento. Os helpers abaixo dão
// a detecção determinística + o 2º passe de extração do container da release.
const TRUNCATED_END_RE = /view changes on github|view on github|view all(?: \d+)? changes?|show more|read more/i;

/** O corpo extraído termina num gatilho de UI ("View changes on GitHub", "Read more", …)? */
export function detectTruncatedEnd(content) {
  const tail = String(content || '').trim().replace(/\s+/g, ' ');
  return TRUNCATED_END_RE.test(tail.slice(-100));
}

// Gatilho como frase/linha TERMINAL: exige fronteira de início de frase/linha antes do gatilho
// (^, pontuação de fim seguida de espaço — por lookbehind, p/ NÃO comer o ponto final —, ou
// quebra de linha). "…want to read more" em prosa NÃO é gatilho (sem fronteira antes de
// "read more"); "…details. Read more" é. Puro/testável.
const TRIGGER_STRIP_RE =
  /(?:^|(?<=[.!?])\s+|\n\s*)(view changes on github|view on github|view all(?: \d+)? changes?|show more|read more)[.!]?\s*$/i;

/** Remove o gatilho de fim quando ele é só UI (frase/linha terminal); prosa fica intacta. */
export function stripTrailingTrigger(content) {
  const s = String(content || '');
  const t = s.trim();
  if (!t) return s;
  const m = TRIGGER_STRIP_RE.exec(t);
  return m ? t.slice(0, m.index).trim() : s;
}

/** O URL é uma release do github.com? (o 2º passe é específico do GitHub). */
export function isGithubUrl(u) {
  try {
    const h = new URL(u).hostname;
    return h === 'github.com' || h === 'www.github.com';
  } catch {
    return false;
  }
}

// Botões de "ver o changelog completo" nas páginas de release do GitHub.
const GITHUB_TRIGGER_RE = /view changes on github|view on github|view all(?: \d+)? changes?/i;

/**
 * 2º passe de extração p/ release notes do GitHub (P5): quando o corpo extraído termina no
 * botão "View changes on GitHub", re-extrai do CONTAINER da release — sobe do botão até o
 * ancestral com >= 400 chars de texto (o corpo da release) e serializa com fronteiras de bloco
 * (blockTextFromHtml). O botão é UI: sai do texto. O chamador usa o resultado SÓ se mais longo
 * que o atual (fail-open: nunca piora o que já tem). Puro/testável.
 */
export function githubReleaseText(html) {
  try {
    const $ = cheerio.load(html || '');
    const isTrigger = (el) => GITHUB_TRIGGER_RE.test($(el).text().trim());
    // Página INTEIRA (não só o container): a nav/sidebar pode trazer um gatilho "View all
    // changes" ANTES do corpo — o 1º em ordem de documento subiria até um ancestral enorme
    // (a página inteira) e reintroduziria lixo. O gatilho que FECHA o corpo da release é o
    // ÚLTIMO em ordem de documento, e vive em main/article quando a página é semântica (a
    // release do GitHub fica em <main id="js-repo-pjax-container">): preferir essa scope,
    // com fallback no documento todo p/ páginas sem main/article.
    const scope = $('main, article').first();
    const inScope = scope.length ? scope.find('a, button') : $('a, button');
    let btn = inScope.filter((_, el) => isTrigger(el)).last();
    if (!btn.length && scope.length) btn = $('a, button').filter((_, el) => isTrigger(el)).last();
    if (!btn.length) return null;
    let cur = btn;
    for (let i = 0; i < 8 && cur.length; i++) {
      if (cur.text().trim().length >= 400) {
        cur.find('a, button').each((_, el) => {
          if (isTrigger(el)) $(el).remove();
        });
        return blockTextFromHtml($.html(cur)) ?? null;
      }
      cur = cur.parent();
    }
  } catch {
    /* fail-open */
  }
  return null;
}

// ---- P6b: moldura de página no fallback (quando a limpeza IA falha) ----
// O `clean` por IA remove spans de sujeira; quando ELE falha, o original cru é salvo COM a
// moldura da página (byline/meta no topo, rodapé/bio no fim — caso meiert.com da captura:
// "Published on Aug 12, 2026, filed under development. (Share this post…)" + "Here on
// meiert.com I talk about some of my perspectives…"). prunePageFrame é o conserto
// DETERMINÍSTICO (sem LLM): padrões CONSERVADORES de moldura de CMS no começo/fim — só
// blocos claramente de moldura saem; prosa nunca.
const FRAME_START_PATTERNS = [
  // byline/meta de blog: "Published on Aug 12, 2026, filed under development. (Share this post…)"
  // (o espaço de "Aug 12" é NBSP no HTML real — por isso \s+ e não espaço literal)
  /^published on [a-z]+\s+\d{1,2},\s+\d{4}, filed under [^.]*\.[^)]*\)\.?\s*/i,
  // banner de pré-release do GitHub (duas variantes de markup vistas na página real)
  /^pre-release\s+pre-release\s+immutable\s+release\.?\s+only release title and notes can be modified\.?\s*/i,
  /^pre-release\s+immutable\s+release\.?\s+only release title and notes can be modified\.?\s*/i,
];

// No FIM: a fronteira de frase/linha antes do padrão impede comer prosa ("…and subscribe to
// the changelog" não é CTA; "…newsletter. Subscribe to the changelog" é). A fronteira de
// pontuação usa lookbehind p/ não comer o ponto final da frase anterior.
const FRAME_END_PATTERNS = [
  // bio/rodapé: "Here on meiert.com I talk about some of my perspectives and experiences."
  /\bhere on [a-z0-9.-]+\.[a-z]{2,} i (?:talk|write|share|blog) about[\s\S]*$/i,
  /(?:^|(?<=[.!?])\s+|\n\s*)share this post[^.!?]*$/i,
  /(?:^|(?<=[.!?])\s+|\n\s*)read next:?[^.!?]*$/i,
  /(?:^|(?<=[.!?])\s+|\n\s*)related (?:posts|articles|stories|reading)[^.!?]*$/i,
  /(?:^|(?<=[.!?])\s+|\n\s*)subscribe(?: to|:)? [^.!?]*$/i,
  /(?:^|(?<=[.!?])\s+|\n\s*)sign up(?: for| to|:)? [^.!?]*$/i,
  /(?:^|(?<=[.!?])\s+|\n\s*)©\s*\d{4}[^.!?]*\.?$/i,
  /(?:^|(?<=[.!?])\s+|\n\s*)all rights reserved\.?$/i,
];

const PRUNE_MAX_SIDES = 3;

/**
 * Remove moldura de página (byline/menu/CTA/rodapé) do COMEÇO e do FIM do corpo —
 * determinístico e conservador: no máx. 3 remoções por lado, cada padrão só casa onde
 * claramente é moldura. Puro/testável.
 */
export function prunePageFrame(content) {
  let s = String(content || '');
  for (let i = 0; i < PRUNE_MAX_SIDES; i++) {
    const before = s;
    for (const re of FRAME_START_PATTERNS) {
      const m = s.match(re);
      if (m && m.index === 0 && m[0].trim()) {
        s = s.slice(m[0].length).trimStart();
        break;
      }
    }
    if (s === before) break;
  }
  for (let i = 0; i < PRUNE_MAX_SIDES; i++) {
    const before = s;
    for (const re of FRAME_END_PATTERNS) {
      const m = s.match(re);
      if (m && m[0].trim()) {
        s = s.slice(0, m.index).trimEnd();
        break;
      }
    }
    if (s === before) break;
  }
  return s.trim();
}
