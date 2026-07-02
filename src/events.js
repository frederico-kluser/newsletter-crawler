// Trace persistente por item: cada estágio do pipeline (fetch, curate, clean, enrich, verify,
// save/skip) grava o que fez/decidiu na tabela events — `ncrawl inspect` lê daqui. As escritas
// são EM LOTE: cada evento entra num buffer em memória e é gravado em UMA transação quando o
// buffer enche (EVENTS_FLUSH_AT) ou no flush explícito do fim do comando (runWithLimits) — corta
// o custo de fsync de milhares de inserts minúsculos sob concorrência. Fail-open: telemetria
// NUNCA derruba um job (falha vira debug; no máximo perde-se o buffer num kill forçado).
import { db, stmts } from './db.js';
import { debug } from './util.js';

const FLUSH_AT = Number(process.env.EVENTS_FLUSH_AT || 50);
const buffer = [];
let _flushTx = null; // transação better-sqlite3 (criada uma vez, reusada)

function flushTx() {
  if (!_flushTx) _flushTx = db.transaction((rows) => rows.forEach((r) => stmts.insertEvent.run(r)));
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
  if (buffer.length >= FLUSH_AT) flushEvents();
}

/** Grava o buffer numa transação e o esvazia. Retorna quantos foram gravados. Idempotente. */
export function flushEvents() {
  if (!buffer.length) return 0;
  const rows = buffer.splice(0);
  try {
    flushTx()(rows);
    return rows.length;
  } catch (e) {
    debug(`events: flush de ${rows.length} falhou (${e.message})`);
    return 0;
  }
}
