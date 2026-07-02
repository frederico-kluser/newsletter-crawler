// Utilitários puros (sem dependência dos módulos de fetch/db, para evitar ciclos).
import crypto from 'node:crypto';
import normalizeUrlLib from 'normalize-url';

/** Normaliza e absolutiza uma URL; retorna null se inválida. */
export function normalizeUrl(u, base) {
  if (!u) return null;
  try {
    const abs = base ? new URL(u, base).href : new URL(u).href;
    return normalizeUrlLib(abs, {
      stripHash: true,
      removeQueryParameters: [/^utm_/i, 'ref', 'fbclid', 'gclid', 'mc_cid', 'mc_eid'],
      sortQueryParameters: true,
      removeTrailingSlash: true,
    });
  } catch {
    return null;
  }
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s || '').digest('hex');
}

/**
 * Traduz uma string de data (Readability/LLM/JSON-LD) para um Date iterável/comparável.
 * Cobre ISO-8601 (com Z, offset, ou milissegundos) e date-only (YYYY-MM-DD -> meia-noite UTC).
 * Defensivo: null/vazio/inválido -> null (nunca lança), p/ uma data ruim não derrubar o crawl.
 */
export function parseDate(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Espera baseMs com jitter de 0.5x–1.5x para cortesia anti-bot. */
export async function jitterDelay(baseMs) {
  if (!baseMs) return;
  await sleep(Math.floor(baseMs * (0.5 + Math.random())));
}

export function hostOf(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
}

/** Assinatura de template: host + tipo de página (chave do cache de seletores).
 * Artigo: 1 template de conteúdo por host. Listagem: inclui um "template" de caminho p/
 * separar arquivos multinível no mesmo host (ex.: /issues vs /issues/<slug>) — segmentos
 * dinâmicos (com dígito ou muito longos, tipo slugs) viram `*`. */
export function domainSig(u, kind = 'listing') {
  const host = hostOf(u);
  if (kind === 'article') return `${host}:article`;
  let pathTpl = '';
  try {
    const segs = new URL(u).pathname
      .split('/')
      .filter(Boolean)
      .map((s) => (/\d/.test(s) || s.length > 24 ? '*' : s));
    pathTpl = '/' + segs.slice(0, 2).join('/');
  } catch {
    pathTpl = '';
  }
  return `${host}:${kind}:${pathTpl}`;
}

export function slugify(s) {
  return (
    (s || 'untitled')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  );
}

/** Fold p/ busca textual local: minúsculas + sem acentos (NFKD). O lower()/LIKE do SQLite só
 * dobram ASCII, então o buscador web registra isto como função SQL (db.js) e aplica o MESMO
 * fold à consulta, casando "Época" com "epoca". */
export function foldText(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}

const ts = () => new Date().toISOString();

// Sink opcional de logs: quando setado (ex.: a UI Ink), TODO o output do crawl vai p/ ele em
// vez do console — sem tocar em crawl.js/fetch.js/classify.js. setLogSink(null) restaura o console.
let logSink = null;
export function setLogSink(fn) {
  logSink = typeof fn === 'function' ? fn : null;
}
const emit = (level, a) => {
  if (!logSink) return false;
  logSink({ level, text: a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ') });
  return true;
};
export const log = (...a) => {
  if (!emit('log', a)) console.log(`[${ts()}]`, ...a);
};
export const warn = (...a) => {
  if (!emit('warn', a)) console.warn(`[${ts()}] WARN`, ...a);
};
export const errorLog = (...a) => {
  if (!emit('error', a)) console.error(`[${ts()}] ERROR`, ...a);
};
// Debug verboso, ligado por env DEBUG=1 (ou true). Vai p/ stderr p/ não poluir stdout.
const DEBUG_ON = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
export const debug = (...a) => {
  if (!DEBUG_ON) return;
  if (!emit('debug', a)) console.error(`[${ts()}] DEBUG`, ...a);
};
