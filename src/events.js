// Trace persistente por item: cada estágio do pipeline (fetch, curate, clean, enrich, verify,
// save/skip) grava o que fez/decidiu na tabela events — `ncrawl inspect` lê daqui. As escritas
// são EM LOTE: cada evento entra num buffer em memória e é gravado em UMA transação quando o
// buffer enche (EVENTS_FLUSH_AT) ou no flush explícito do fim do comando (runWithLimits) — corta
// o custo de fsync de milhares de inserts minúsculos sob concorrência. Fail-open: telemetria
// NUNCA derruba um job (falha vira debug; no máximo perde-se o buffer num kill forçado).
//
// As DECISÕES do Jev (1 linha por pergunta, tabela jev_decisions) pegam carona no MESMO buffer
// e na MESMA transação (logDecision): um flush grava events + decisões juntos — nada de um segundo
// relógio de fsync, e o inspect nunca vê a decisão sem o evento do item (ou vice-versa).
import { db, stmts } from './db.js';
import { debug } from './util.js';

const FLUSH_AT = Number(process.env.EVENTS_FLUSH_AT || 50);
const buffer = [];
const decisionBuffer = [];
let _flushTx = null; // transação better-sqlite3 (criada uma vez, reusada)

// Desfechos aceitos pelo CHECK da tabela. Uma linha fora disso faria o INSERT falhar e — como o
// flush é UMA transação — levaria junto todos os events do lote; por isso é descartada ANTES.
export const DECISION_OUTCOMES = Object.freeze(['accept', 'fallback', 'default', 'error', 'shadow']);
const OUTCOME_SET = new Set(DECISION_OUTCOMES);
const TRACE_MODES = new Set(['off', 'min', 'full']);
// Taxa default da AMOSTRA de aceitos no modo min: 5% basta p/ medir a concordância dos aceitos sem
// encher o banco (um crawl classifica dezenas de perguntas por artigo).
const DEFAULT_ACCEPT_SAMPLE = 0.05;

const pending = () => buffer.length + decisionBuffer.length;

function flushTx() {
  if (!_flushTx) {
    _flushTx = db.transaction((events, decisions) => {
      for (const r of events) stmts.insertEvent.run(r);
      for (const d of decisions) stmts.insertJevDecision.run(d);
    });
  }
  return _flushTx;
}

export function logEvent({ runId = null, sourceId = null, url = null, stage, status, detail = null }) {
  let d = null;
  try {
    d = detail == null ? null : JSON.stringify(detail);
  } catch {
    d = null; // detail circular/serialização falhou: grava sem detalhe
  }
  buffer.push({ run_id: runId, source_id: sourceId, url, stage, status, detail: d });
  if (pending() >= FLUSH_AT) flushEvents();
}

/**
 * Grava o buffer (events + decisões do Jev) numa transação e o esvazia. Retorna quantas linhas
 * foram gravadas (as duas tabelas somadas). Idempotente.
 */
export function flushEvents() {
  if (!pending()) return 0;
  const rows = buffer.splice(0);
  const decisions = decisionBuffer.splice(0);
  try {
    flushTx()(rows, decisions);
    return rows.length + decisions.length;
  } catch (e) {
    debug(`events: flush de ${rows.length} evento(s) + ${decisions.length} decisão(ões) falhou (${e.message})`);
    return 0;
  }
}

// ---- decisões do Jev (jev_decisions) ----

/** Modo do trace, lido NA HORA (o eval/teste troca por env sem reimportar): off | min | full. */
export function traceMode() {
  const m = String(process.env.JEV_TRACE || 'min').trim().toLowerCase();
  return TRACE_MODES.has(m) ? m : 'min';
}

function acceptSampleRate() {
  const raw = process.env.JEV_TRACE_SAMPLE;
  if (raw == null || String(raw).trim() === '') return DEFAULT_ACCEPT_SAMPLE;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_ACCEPT_SAMPLE;
}

/**
 * Posição DETERMINÍSTICA em [0,1) de um (subject, qid) — FNV-1a 32 bits. Sem Math.random de
 * propósito: o MESMO item/pergunta cai sempre do mesmo lado da amostra, então duas runs (ou a
 * run e o replay do eval) amostram os mesmos aceitos e a concordância é comparável.
 */
export function traceBucket(subject, qid) {
  const s = `${subject ?? ''}\u0000${qid ?? ''}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

/**
 * A taxa com que a decisão ENTRA no log (vai p/ a coluna sample_rate), ou 0 = não registrar.
 * full: tudo (1). min: todo desfecho não-aceito (1) + aceitos cujo bucket cai abaixo da taxa
 * (JEV_TRACE_SAMPLE, default 5%). off: nada.
 */
export function decisionSampleRate(row, { mode = traceMode(), rate = acceptSampleRate() } = {}) {
  if (mode === 'off') return 0;
  if (mode === 'full' || row?.outcome !== 'accept') return 1;
  if (!(rate > 0)) return 0;
  return traceBucket(row.subject ?? row.url, row.qid) < rate ? rate : 0;
}

// string crua (a opção de um choice é o caso comum e fica legível no SQL); o resto vira JSON.
function encodeValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v); // circular: melhor um rótulo do que perder a linha
  }
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function boolIntOrNull(v) {
  if (v === true || v === 1 || v === '1') return 1;
  if (v === false || v === 0 || v === '0') return 0;
  return null;
}

const textOrNull = (v) => (v === undefined || v === null || v === '' ? null : String(v));

/** Normaliza 1 decisão p/ os parâmetros do insertJevDecision, ou null quando inválida. */
function toDecisionRow(r, opts, mode, rate) {
  if (!r || typeof r !== 'object') return null;
  const stage = textOrNull(r.stage ?? opts.stage);
  const qid = textOrNull(r.qid);
  const outcome = String(r.outcome ?? '').toLowerCase();
  if (!stage || !qid || !OUTCOME_SET.has(outcome)) {
    debug(`events: decisão descartada (stage=${stage} qid=${qid} outcome=${r.outcome})`);
    return null;
  }
  const subject = textOrNull(r.subject ?? opts.subject);
  const url = textOrNull(r.url ?? opts.url);
  const sampleRate = decisionSampleRate({ outcome, subject, url, qid }, { mode, rate });
  if (!sampleRate) return null;
  return {
    run_id: numOrNull(r.runId ?? opts.runId),
    stage,
    subject,
    url,
    qid,
    value: encodeValue(r.value),
    p: numOrNull(r.p),
    certainty: numOrNull(r.certainty),
    threshold: numOrNull(r.threshold),
    outcome,
    reason: textOrNull(r.reason),
    fb_value: encodeValue(r.fbValue ?? r.fb_value),
    agree: boolIntOrNull(r.agree),
    model: textOrNull(r.model ?? opts.model),
    sample_rate: sampleRate,
  };
}

/**
 * Enfileira decisões do Jev p/ a tabela jev_decisions — no MESMO buffer/transação dos events.
 * rows: [{ qid, outcome:'accept'|'fallback'|'default'|'error'|'shadow', value?, p?, certainty?,
 *          threshold?, reason?, fbValue?, agree?, subject?, url?, stage?, model? }]
 * opts: { runId, url, stage, subject, model } — defaults de cada linha (a linha vence).
 * Respeita JEV_TRACE (min|full|off, lido na hora). Devolve quantas linhas entraram no buffer.
 * NUNCA lança: decisão inválida é descartada com debug (não pode derrubar o flush dos events).
 */
export function logDecision(rows, opts = {}) {
  try {
    const mode = traceMode();
    if (mode === 'off') return 0;
    const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
    const rate = acceptSampleRate();
    const o = opts && typeof opts === 'object' ? opts : {};
    let kept = 0;
    for (const r of list) {
      const row = toDecisionRow(r, o, mode, rate);
      if (row) {
        decisionBuffer.push(row);
        kept++;
      }
    }
    if (pending() >= FLUSH_AT) flushEvents();
    return kept;
  } catch (e) {
    debug(`events: logDecision falhou (${e.message})`);
    return 0;
  }
}
