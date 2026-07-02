// Trace persistente por item: cada estágio do pipeline (fetch, curate, clean, enrich, verify,
// save/skip) grava o que fez/decidiu na tabela events — `ncrawl inspect` lê daqui. Fail-open:
// telemetria NUNCA derruba um job (um insert falho vira debug e o crawl segue).
import { stmts } from './db.js';
import { debug } from './util.js';

export function logEvent({ runId = null, sourceId = null, url = null, stage, status, detail = null }) {
  try {
    stmts.insertEvent.run({
      run_id: runId,
      source_id: sourceId,
      url,
      stage,
      status,
      detail: detail == null ? null : JSON.stringify(detail),
    });
  } catch (e) {
    debug(`event não gravado (${stage}/${status}): ${e.message}`);
  }
}
