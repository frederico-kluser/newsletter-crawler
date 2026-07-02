// Rastreador de progresso da run (progress.js): % por data rumo ao --since (fórmula, clamp,
// floorHit=100, fonte sem data fora da média global), fases ativas e contadores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  progressReset, progressSnapshot, sourceSeen, sourceListingDone, dateSeen, floorHit,
  bump, stageEnter, stageExit, inStage,
} from '../src/progress.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-07-02T00:00:00Z');

test('% por data: (agora − mais antiga vista) ÷ (agora − since); floorHit = 100; sem data = null', () => {
  progressReset({ sinceDate: new Date(NOW - 10 * DAY) });
  sourceSeen(1, 'meio-caminho');
  sourceSeen(2, 'no-alvo');
  sourceSeen(3, 'sem-data');
  dateSeen(1, new Date(NOW - 5 * DAY)); // metade do caminho até o alvo
  dateSeen(1, new Date(NOW - 2 * DAY)); // mais nova NÃO regride o oldest
  floorHit(2);
  sourceListingDone(2);

  const p = progressSnapshot(NOW);
  assert.equal(p.since, new Date(NOW - 10 * DAY).toISOString().slice(0, 10));
  assert.equal(p.sources.find((s) => s.id === 1).pct, 50);
  assert.equal(p.sources.find((s) => s.id === 2).pct, 100);
  assert.equal(p.sources.find((s) => s.id === 3).pct, null); // não entra na média
  assert.equal(p.pctGlobal, 75);
  assert.equal(p.sourcesTotal, 3);
  assert.equal(p.sourcesListingDone, 1);
});

test('data mais antiga que o alvo clampa em 100; sem --since o pct é null', () => {
  progressReset({ sinceDate: new Date(NOW - 10 * DAY) });
  sourceSeen(1, 'passou-do-alvo');
  dateSeen(1, new Date(NOW - 15 * DAY));
  assert.equal(progressSnapshot(NOW).sources[0].pct, 100);

  progressReset({}); // sem sinceDate
  sourceSeen(1, 'a');
  dateSeen(1, new Date(NOW - 5 * DAY));
  const p = progressSnapshot(NOW);
  assert.equal(p.sources[0].pct, null);
  assert.equal(p.pctGlobal, null);
  assert.equal(p.since, null);
});

test('fases entram/saem (inStage limpa até com erro) e contadores acumulam', async () => {
  progressReset({});
  stageEnter('fetch');
  stageEnter('fetch');
  stageExit('fetch');
  assert.equal(progressSnapshot(NOW).stages.fetch, 1);
  stageExit('fetch');
  assert.equal(progressSnapshot(NOW).stages.fetch, undefined);

  await assert.rejects(() => inStage('limpeza', () => Promise.reject(new Error('x'))));
  assert.equal(progressSnapshot(NOW).stages.limpeza, undefined);

  bump('salvos');
  bump('salvos', 2);
  assert.equal(progressSnapshot(NOW).counts.salvos, 3);
});

test('dateSeen ignora fonte desconhecida e data inválida (fail-open)', () => {
  progressReset({ sinceDate: new Date(NOW - 10 * DAY) });
  sourceSeen(1, 'a');
  dateSeen(99, new Date(NOW - 5 * DAY)); // fonte não semeada: no-op
  dateSeen(1, null);
  dateSeen(1, new Date('invalid'));
  const p = progressSnapshot(NOW);
  assert.equal(p.sources.find((s) => s.id === 1).pct, null);
  assert.equal(p.sources.length, 1);
});
