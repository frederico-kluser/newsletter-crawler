// Utilitários puros (sem dependência dos módulos de fetch/db, para evitar ciclos).
import crypto from 'node:crypto';
import { openSync, writeSync, closeSync, mkdirSync, unlinkSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import normalizeUrlLib from 'normalize-url';

/** Normaliza e absolutiza uma URL; retorna null se inválida. */
export function normalizeUrl(u, base) {
  if (!u) return null;
  try {
    const abs = base ? new URL(u, base).href : new URL(u).href;
    return normalizeUrlLib(abs, {
      // NÃO remover "www.": www.host e host podem ser servidores DIFERENTES — vários Substack de
      // domínio próprio (ex.: www.deeplearningweekly.com) NÃO têm DNS no ápice, então colapsar
      // www->ápice gera URL morta (ENOTFOUND). hostOf/domainSig já preservam o www; isto alinha.
      stripWWW: false,
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

// Tolerância p/ fuso: um boletim publicado "amanhã" em UTC+13 é legítimo; 2 dias à frente, não.
const FUTURE_DATE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * Trava de data no FUTURO, aplicada na COLETA (antes de gravar published_at). Extração errada de
 * data (JSON-LD de "próxima edição", regex pegando o ano errado) cravava o item no topo do site
 * para sempre — ordenamos por data. Passou de hoje + 1 dia? grava a data de hoje (YYYY-MM-DD).
 * Data inparseável ou dentro do prazo volta INTACTA: published_at é string crua do scrape e quem
 * normaliza é o iso_date do db.js.
 */
export function clampFutureDate(raw, now = new Date()) {
  const d = parseDate(raw);
  if (!d) return raw;
  return d.getTime() > now.getTime() + FUTURE_DATE_TOLERANCE_MS ? now.toISOString().slice(0, 10) : raw;
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
/** A TUI está capturando os logs via sink? (alguns emissores duplicam marcos se o sink já
 * converte erro->evento — o CLI, sem sink, emite o marco ele mesmo.) */
export function hasLogSink() {
  return logSink != null;
}

// ---- log persistente por processo (NC_HOME/logs) ----
// openLogFile() grava TODO o log do processo (log/warn/errorLog/debug) num arquivo com flush
// IMEDIATO (writeSync = syscall direto, sem buffer userspace): um `tail -f` do arquivo vê cada
// linha NA HORA, mesmo quando o stdout do processo está buferizado num pipe (`npm run crawl |
// tee` cegava o observador por minutos — o arquivo mata esse problema por construção). O sink da
// TUI e o console NÃO mudam de comportamento (o sink continua recebendo {level, text} sem
// timestamp; o console recebe a linha formatada como antes). Fail-open: qualquer erro de
// filesystem apenas desliga o arquivo, nunca derruba o comando.
const LEVEL_MARK = { log: '', warn: ' WARN', error: ' ERROR', debug: ' DEBUG' };
let logFd = null;
let logPathStr = null;

// Mesma regra do config.js (NC_HOME override por env; default ~/.newsletter-crawler) — sem
// importar config p/ manter util pura (config importa util).
function ncHomeDir() {
  return process.env.NC_HOME
    ? path.resolve(process.env.NC_HOME)
    : path.join(os.homedir(), '.newsletter-crawler');
}

/** Abre (ou troca) o arquivo de log do processo: NC_HOME/logs/<comando>-<ts>-<pid>.log + um
 * symlink estável NC_HOME/logs/latest.log apontando p/ ele (p/ `tail -f latest.log`). Retorna o
 * caminho, ou null se o filesystem recusar (fail-open). Idempotente: chamar de novo fecha o fd
 * anterior e grava num arquivo novo. */
export function openLogFile({ command = 'ncrawl' } = {}) {
  const name = String(command || 'ncrawl').replace(/[^a-z0-9-]+/gi, '-');
  try {
    const dir = path.join(ncHomeDir(), 'logs');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${name}-${stamp}-${process.pid}.log`);
    const fd = openSync(file, 'a');
    if (logFd != null) {
      try { closeSync(logFd); } catch { /* já fechado */ }
    }
    logFd = fd;
    logPathStr = file;
    // Ponteiro estável p/ tail -f (symlink RELATIVO: o alvo vive no MESMO diretório).
    try {
      const latest = path.join(dir, 'latest.log');
      try { unlinkSync(latest); } catch { /* ainda não existe (ou já era dangling): ok */ }
      symlinkSync(path.basename(file), latest);
    } catch { /* symlink é conveniência; o arquivo datado segue sendo gravado */ }
    return file;
  } catch {
    logFd = null;
    logPathStr = null;
    return null;
  }
}

/** Caminho do arquivo de log do processo atual (null se nenhum foi aberto). */
export function logFilePath() {
  return logPathStr;
}

/** Fecha o arquivo de log (o próximo log() cai só no console/sink de sempre). */
export function closeLogFile() {
  if (logFd != null) {
    try { closeSync(logFd); } catch { /* idem */ }
    logFd = null;
    logPathStr = null;
  }
}

// Formata um valor p/ a linha do ARQUIVO (o sink/console recebem os args crus como hoje):
// objetos viram JSON, erros viram stack — nunca "[object Object]".
const fmtLogValue = (x) => {
  if (typeof x === 'string') return x;
  if (x instanceof Error) return x.stack || x.message || String(x);
  if (x && typeof x === 'object') {
    try { return JSON.stringify(x); } catch { return String(x); }
  }
  return String(x);
};

const emit = (level, a) => {
  const stamp = `[${ts()}]${LEVEL_MARK[level] || ''}`;
  const text = a.map(fmtLogValue).join(' ');
  // Log persistente (flush imediato: writeSync passa por cima de qualquer buffer de usuário).
  if (logFd != null) {
    try {
      writeSync(logFd, `${stamp} ${text}\n`);
    } catch {
      /* gravação de log nunca derruba o processo */
    }
  }
  if (logSink) {
    logSink({ level, text });
    return true;
  }
  if (level === 'log') console.log(stamp, ...a);
  else if (level === 'warn') console.warn(stamp, ...a);
  else console.error(stamp, ...a); // error e debug vão p/ stderr (não polui stdout)
  return false;
};
export const log = (...a) => {
  emit('log', a); // o próprio emit decide: arquivo -> sink -> console
};
export const warn = (...a) => {
  emit('warn', a);
};
export const errorLog = (...a) => {
  emit('error', a);
};
// Debug verboso, ligado por env DEBUG=1 (ou true). Vai p/ stderr p/ não poluir stdout.
const DEBUG_ON = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
export const debug = (...a) => {
  if (!DEBUG_ON) return;
  emit('debug', a);
};
