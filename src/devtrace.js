// Modo de DESENVOLVIMENTO LLM (--llm-dev / NC_LLM_DEV=1) — trace JSONL de tudo o que uma run faz,
// para a LLM analisar erros EM TEMPO REAL. Não é para o utilizador final: não escreve nada no
// stdout/TUI — só em NC_HOME/logs/trace-<ts>.jsonl (+ symlink latest.jsonl p/ `tail -f`).
// Documentado em AGENTS.md (## Modo de desenvolvimento LLM (trace)).
//
// Desenhado p/ ser chamado de QUALQUER lugar (llm/fetch/commands/curate/crawl) sem ciclos nem
// custo quando off: `devTraceEnabled()` é o gate barato nos call sites que montam payloads caros e
// `devTrace()` é um no-op total sem I/O quando desligado. Fail-open por construção: qualquer erro
// de filesystem desliga o trace, nunca derruba o comando.
//
// Cuidado herdado do GH013 (ago/2026): o trace pode conter texto de artigos com um token REAL —
// TODO valor de string passa por `redactSecrets` (src/redact.js) antes de tocar o disco, e o que
// for gigante é TRUNCADO com marcador (`NC_LLM_DEV_MAX_CHARS`, default 8k por string).
import { closeSync, mkdirSync, openSync, readdirSync, symlinkSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './redact.js';
import { ncHomeDir } from './util.js';

const envOn = () => /^(1|true|on|yes)$/i.test(process.env.NC_LLM_DEV || '');
const envInt = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

const MAX_CHARS_DEFAULT = 8192;
const KEEP_DEFAULT = 20;
const MAX_DEPTH = 6;
const MAX_ARRAY = 200;

let _on = false;
let _fd = null;
let _path = null;
let _seq = 0;

/** O trace está ligado? (gate barato p/ call sites que montam payloads caros) */
export function devTraceEnabled() {
  return _on;
}

/** Caminho do trace atual (null se off/não aberto). */
export function devTracePath() {
  return _path;
}

// ---- saneamento do payload: redige segredos e trunca o gigante (recursivo, fail-open) ----

function scrub(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') {
    const clean = redactSecrets(value);
    const max = envInt('NC_LLM_DEV_MAX_CHARS', MAX_CHARS_DEFAULT);
    if (clean.length <= max) return clean;
    return `${clean.slice(0, max)}…[TRUNCADO ${clean.length - max} chars]`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return { error: value.name, message: redactSecrets(String(value.message || '')), stack: scrub(String(value.stack || ''), depth + 1) };
  }
  if (depth >= MAX_DEPTH) return '[profundidade máx]';
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => scrub(v, depth + 1));
    if (value.length > MAX_ARRAY) head.push(`…+${value.length - MAX_ARRAY} itens`);
    return head;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || typeof v === 'function') continue;
      out[k] = scrub(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

// ---- escrita (flush IMEDIATO: tail -f vê cada evento na hora) ----

function writeLine(obj) {
  if (!_on || _fd == null) return;
  try {
    _seq += 1;
    const line = JSON.stringify({ t: new Date().toISOString(), seq: _seq, ...scrub(obj) }) + '\n';
    writeSync(_fd, line);
  } catch {
    // fail-open: trace nunca derruba o comando (filesystem cheio/permissão: desliga)
    try { closeSync(_fd); } catch { /* já fechado */ }
    _fd = null;
    _on = false;
  }
}

/** Evento genérico: `devTrace('llm.call', { stage, model, … })` → 1 linha JSONL. No-op se off. */
export function devTrace(type, data = {}) {
  if (!_on) return;
  writeLine({ type, ...data });
}

/** Evento de ERRO com stack (err instanceof Error vira {error,message,stack}). No-op se off. */
export function devTraceErr(type, err, extra = {}) {
  if (!_on) return;
  writeLine({ type, err, ...extra });
}

/**
 * Liga (se pedido/NC_LLM_DEV) e abre o trace do processo: NC_HOME/logs/trace-<ts>-<pid>.jsonl +
 * symlink estável `latest.jsonl` (p/ `tail -f $NC_HOME/logs/latest.jsonl`). Grava o evento-cabeçalho
 * `meta` com o contexto da run (comando, argv, node, pid + o `meta` que o chamador passar — ex.:
 * provider/modelos/lanes) e PODA os traces antigos (retenção `NC_LLM_DEV_KEEP`, default 20).
 *
 * Retorna o caminho, ou null (e nada muda) quando off/fail-open. Idempotente: re-chamar fecha o
 * anterior e abre um novo.
 */
export function maybeInitDevTrace({ command = 'ncrawl', argv = [], want = false, meta = {} } = {}) {
  if (!want && !envOn()) return null;
  try {
    const dir = path.join(ncHomeDir(), 'logs');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `trace-${stamp}-${process.pid}.jsonl`);
    const fd = openSync(file, 'a');
    if (_fd != null) {
      try { closeSync(_fd); } catch { /* já fechado */ }
    }
    _fd = fd;
    _path = file;
    _on = true;
    _seq = 0;
    try {
      const latest = path.join(dir, 'latest.jsonl');
      try { unlinkSync(latest); } catch { /* ainda não existe: ok */ }
      symlinkSync(path.basename(file), latest);
    } catch { /* symlink é conveniência; o arquivo datado segue sendo gravado */ }
    pruneOldTraces(dir);
    writeLine({
      type: 'meta',
      command,
      argv: argv.map(String),
      node: process.version,
      pid: process.pid,
      llmDev: { keep: envInt('NC_LLM_DEV_KEEP', KEEP_DEFAULT), maxChars: envInt('NC_LLM_DEV_MAX_CHARS', MAX_CHARS_DEFAULT) },
      meta,
    });
    return file;
  } catch {
    _fd = null;
    _path = null;
    _on = false;
    return null;
  }
}

/** Poda de retenção: mantém os NC_LLM_DEV_KEEP (default 20) traces mais recentes. */
function pruneOldTraces(dir) {
  try {
    const keep = envInt('NC_LLM_DEV_KEEP', KEEP_DEFAULT);
    const files = readdirSync(dir)
      .filter((f) => /^trace-.*\.jsonl$/.test(f))
      .sort(); // nome carrega timestamp ISO → ordem cronológica
    const excess = files.slice(0, Math.max(0, files.length - keep));
    for (const f of excess) {
      try { unlinkSync(path.join(dir, f)); } catch { /* melhor esforço */ }
    }
  } catch { /* fail-open */ }
}

/** Evento final (resumo da run) + fecha o arquivo. Idempotente. */
export function endDevTrace(summary = {}) {
  if (!_on) return;
  writeLine({ type: 'end', ...summary });
  try { if (_fd != null) closeSync(_fd); } catch { /* já fechado */ }
  _fd = null;
  _on = false;
}
