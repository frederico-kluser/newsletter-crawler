// Escritas em lote dos eventos: logEvent empilha no buffer; a gravação acontece no auto-flush
// (buffer cheio) ou no flushEvents() explícito, numa transação. EVENTS_FLUSH_AT baixo + NC_HOME
// temporário setados ANTES do import (config/db leem no load).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-events-'));
process.env.EVENTS_FLUSH_AT = '3';
const { logEvent, flushEvents } = await import('../src/events.js');
const { db } = await import('../src/db.js');

const count = () => db.prepare('SELECT COUNT(*) c FROM events').get().c;

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

test('logEvent NÃO grava na hora — fica no buffer até o flush', () => {
  logEvent({ runId: 1, url: 'a', stage: 'fetch', status: 'ok' });
  logEvent({ runId: 1, url: 'b', stage: 'fetch', status: 'ok' });
  assert.equal(count(), 0, 'ainda no buffer (2 < FLUSH_AT=3)');
});

test('auto-flush ao encher o buffer (>= EVENTS_FLUSH_AT) grava tudo numa transação', () => {
  logEvent({ runId: 1, url: 'c', stage: 'save', status: 'ok', detail: { x: 1 } }); // 3º -> flush
  assert.equal(count(), 3);
});

test('flushEvents() explícito grava o resto e devolve a contagem; detail vira JSON', () => {
  logEvent({ runId: 2, url: 'd', stage: 'verify', status: 'suspect', detail: { problems: ['ruído'] } });
  assert.equal(flushEvents(), 1);
  assert.equal(count(), 4);
  const row = db.prepare("SELECT detail FROM events WHERE url = 'd'").get();
  assert.deepEqual(JSON.parse(row.detail), { problems: ['ruído'] });
  assert.equal(flushEvents(), 0, 'buffer vazio: no-op');
});
