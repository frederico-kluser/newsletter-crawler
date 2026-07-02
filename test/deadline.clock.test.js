// Relógio de TRABALHO por job (createJobClock): só as fases run() contam no orçamento; wait()
// fica de fora (espera de fila/LLM); expirar ABORTA o AbortSignal com code JOB_TIMEOUT — é o
// que mata o job zumbi de verdade (a causa da cascata de 100% de estouros).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobClock, abortErrorOf } from '../src/deadline.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('wait() não consome orçamento; run() consome, expira e aborta o signal', async () => {
  const clock = createJobClock(80);
  await clock.wait('fila', () => sleep(120)); // espera maior que o orçamento: NÃO expira
  assert.equal(clock.expired(), false);
  assert.equal(clock.signal.aborted, false);

  await clock.run('fetch', () => sleep(160)); // trabalho estoura os 80ms
  assert.equal(clock.expired(), true);
  assert.equal(clock.signal.aborted, true);
  assert.equal(clock.signal.reason?.code, 'JOB_TIMEOUT');

  const s = clock.snapshot();
  assert.ok(s.waits.fila >= 100, `espera medida: ${s.waits.fila}`);
  assert.ok(s.phases.fetch >= 60, `fase fetch medida: ${s.phases.fetch}`);
  assert.equal(s.expired, true);
});

test('depois de abortado, run() rejeita com o reason (o job não segue trabalhando)', async () => {
  const clock = createJobClock(30);
  await clock.run('fetch', () => sleep(80));
  assert.equal(clock.expired(), true);
  await assert.rejects(() => clock.run('parse', () => sleep(1)), (e) => e.code === 'JOB_TIMEOUT');
});

test('trabalho dentro do orçamento não expira; o gasto acumula entre fases', async () => {
  const clock = createJobClock(500);
  await clock.run('fetch', () => sleep(40));
  await clock.run('parse', () => sleep(40));
  assert.equal(clock.expired(), false);
  const s = clock.snapshot();
  assert.ok(s.phases.fetch >= 25 && s.phases.parse >= 25);
  assert.ok(s.workMs >= 60);
});

test('abort manual (teto duro de parede) marca expirado com a razão no snapshot', () => {
  const clock = createJobClock(60_000);
  clock.abort('hard-cap');
  assert.equal(clock.expired(), true);
  assert.equal(clock.signal.reason?.code, 'JOB_TIMEOUT');
  assert.equal(clock.snapshot().abortReason, 'hard-cap');
});

test('ms<=0 desliga o relógio (nunca expira, budgetMs=0)', async () => {
  const clock = createJobClock(0);
  await clock.run('fetch', () => sleep(30));
  assert.equal(clock.expired(), false);
  assert.equal(clock.snapshot().budgetMs, 0);
});

test('re-entrância: run() aninhado conta na fase externa (não zera o relógio)', async () => {
  const clock = createJobClock(500);
  await clock.run('render', () => clock.run('interno', () => sleep(30)));
  const s = clock.snapshot();
  assert.ok(s.phases.render >= 20);
  assert.equal(s.phases.interno, undefined);
});

test('abortErrorOf devolve o reason do signal (ou um erro JOB_TIMEOUT coerente)', () => {
  const clock = createJobClock(50);
  clock.abort('x');
  assert.equal(abortErrorOf(clock.signal).code, 'JOB_TIMEOUT');
  assert.equal(abortErrorOf(null).code, 'JOB_TIMEOUT');
});
