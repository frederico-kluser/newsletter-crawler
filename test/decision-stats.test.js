// Placar em memória das decisões do Jev (src/decision-stats.js, W1-C): contagem por desfecho e por
// motivo, fatia não-aceita (fallback+default+error; shadow conta como aceita), cópia no snapshot,
// reset, e a TEMPESTADE de fallback — fatia não-aceita > JEV_STORM_RATE (0.6) nas últimas
// JEV_STORM_WINDOW (50) decisões do estágio, depois de JEV_STORM_MIN (20): UM warn + UM events row
// 'jev/storm' + um marco 'jev-fallback-storm' no feed da TUI por episódio; re-arma com histerese.
// Sandbox de env antes do import (o events row cai num NC_HOME temporário).
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxEnv } from './helpers/env.js';

const sb = sandboxEnv({ EVENTS_FLUSH_AT: '1000' }, { homePrefix: 'nc-dstats-' });
// Redundante com a sandbox (que já setou) — explícito p/ a malha do nc-home-isolation.test.js, que
// audita o assignment literal ANTES do 1º import de src/.
process.env.NC_HOME = sb.home;
const ds = await import('../src/decision-stats.js');
const { flushEvents } = await import('../src/events.js');
const { db } = await import('../src/db.js');
const { setLogSink } = await import('../src/util.js');
const { runEventsReset, runEventsSnapshot } = await import('../src/run-events.js');

const warns = [];
setLogSink((e) => {
  if (e.level === 'warn') warns.push(e.text);
});

after(() => {
  setLogSink(null);
  db.close();
  sb.restore();
});

beforeEach(() => {
  ds.reset();
  warns.length = 0;
  runEventsReset();
  flushEvents();
  db.exec('DELETE FROM events');
  for (const k of ['JEV_STORM_RATE', 'JEV_STORM_WINDOW', 'JEV_STORM_MIN']) delete process.env[k];
});

const rows = (outcome, n, reason) => Array.from({ length: n }, () => ({ outcome, reason }));
const stormEvents = () => {
  flushEvents();
  return db.prepare("SELECT * FROM events WHERE stage = 'jev' AND status = 'storm' ORDER BY id").all();
};

test('conta por desfecho e por motivo; fatia não-aceita; shadow conta como aceita', () => {
  ds.record('verifyRecordJev', [
    ...rows('accept', 6),
    ...rows('shadow', 2),
    ...rows('fallback', 3, 'low-confidence'),
    { outcome: 'fallback', reason: 'escape-option' },
    { outcome: 'default', reason: 'fallback-budget' },
    { outcome: 'error' }, // sem motivo
    { outcome: 'maybe' }, // inválido: ignorado
    null,
  ]);
  const s = ds.snapshot().byStage.verifyRecordJev;
  assert.equal(s.decisions, 14);
  assert.equal(s.accept, 6);
  assert.equal(s.shadow, 2);
  assert.equal(s.fallback, 4);
  assert.equal(s.default, 1);
  assert.equal(s.error, 1);
  assert.deepEqual(s.byReason, {
    fallback: { 'low-confidence': 3, 'escape-option': 1 },
    default: { 'fallback-budget': 1 },
    error: { unspecified: 1 },
  });
  assert.equal(s.fallbackRate, Math.round((6 / 14) * 1e4) / 1e4);
  assert.equal(ds.fallbackRate('verifyRecordJev'), 6 / 14);
  assert.equal(ds.fallbackRate('nunca'), null);
  assert.equal(s.storm, false);
});

test('snapshot é cópia; totals somam os estágios; reset zera', () => {
  ds.record('classifyJev', rows('accept', 3));
  ds.record('searchBatchJev', rows('fallback', 1, 'low-confidence'));
  const snap = ds.snapshot();
  assert.equal(snap.totals.decisions, 4);
  assert.equal(snap.totals.fallback, 1);
  assert.equal(snap.totals.fallbackRate, 0.25);
  snap.byStage.classifyJev.accept = 999;
  snap.byStage.searchBatchJev.byReason.fallback['low-confidence'] = 999;
  const again = ds.snapshot();
  assert.equal(again.byStage.classifyJev.accept, 3);
  assert.equal(again.byStage.searchBatchJev.byReason.fallback['low-confidence'], 1);
  ds.reset();
  assert.deepEqual(ds.snapshot().byStage, {});
  assert.equal(ds.snapshot().totals.decisions, 0);
});

test('entrada torta nunca lança', () => {
  assert.deepEqual(ds.record('', rows('accept', 2)), { storm: null });
  assert.deepEqual(ds.record('x', null), { storm: null });
  assert.deepEqual(ds.record(undefined, undefined), { storm: null });
  assert.doesNotThrow(() => ds.record('x', { outcome: 'accept' }), 'linha única (não-array)');
  assert.equal(ds.snapshot().byStage.x.accept, 1);
});

test('tempestade: abaixo do mínimo não dispara; acima do limiar dispara UMA vez (warn + events + feed)', () => {
  const r1 = ds.record('classifyJev', rows('fallback', 19, 'low-confidence'), { runId: 42 });
  assert.equal(r1.storm, null, '19 < JEV_STORM_MIN (20)');
  assert.equal(warns.length, 0);
  const r2 = ds.record('classifyJev', rows('fallback', 1, 'low-confidence'), { runId: 42 });
  assert.ok(r2.storm, 'a 20ª decisão fecha a amostra mínima');
  assert.equal(r2.storm.stage, 'classifyJev');
  assert.equal(r2.storm.rate, 1);
  assert.equal(r2.storm.threshold, 0.6);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /tempestade de fallback em classifyJev — 100%/);
  // continua em tempestade: nada de rajada de avisos
  ds.record('classifyJev', rows('fallback', 30, 'low-confidence'), { runId: 42 });
  assert.equal(warns.length, 1);
  const ev = stormEvents();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].run_id, 42);
  const detail = JSON.parse(ev[0].detail);
  assert.equal(detail.stage, 'classifyJev');
  assert.equal(detail.threshold, 0.6);
  assert.deepEqual(detail.byReason.fallback, { 'low-confidence': 20 });
  const feed = runEventsSnapshot().feed.filter((e) => e.kind === 'jev-fallback-storm');
  assert.equal(feed.length, 1);
  assert.equal(feed[0].level, 'warn');
  const s = ds.snapshot().byStage.classifyJev;
  assert.equal(s.storm, true);
  assert.equal(s.storms, 1);
  assert.equal(s.windowSize, 50, 'a janela guarda só as últimas 50');
  assert.equal(ds.snapshot().storms.length, 1);
});

test('tempestade re-arma com histerese: cai à metade do limiar e um novo pico avisa de novo', () => {
  ds.record('curateJev', rows('fallback', 25, 'escape-option'));
  assert.equal(warns.length, 1);
  // 25 fb + 25 ok = 50% (entre 30% e 60%): ainda o MESMO episódio, sem novo aviso
  ds.record('curateJev', rows('accept', 25));
  assert.equal(ds.snapshot().byStage.curateJev.storm, true);
  // janela inteira aceita: 0% <= 30% → encerra o episódio
  ds.record('curateJev', rows('accept', 50));
  assert.equal(ds.snapshot().byStage.curateJev.storm, false);
  // novo pico: 40 de 50 = 80% > 60%
  const r = ds.record('curateJev', rows('fallback', 40, 'low-confidence'));
  assert.ok(r.storm);
  assert.equal(warns.length, 2);
  assert.equal(ds.snapshot().byStage.curateJev.storms, 2);
  assert.equal(stormEvents().length, 2);
});

test('a fatia que dispara é "não aceita": default e error também contam; shadow não', () => {
  ds.record('detectTypeJev', [...rows('default', 10, 'fallback-budget'), ...rows('error', 10, 'jev-error')]);
  assert.equal(warns.length, 1, 'Jev fora do ar + fallback sem orçamento é tempestade');
  ds.reset();
  warns.length = 0;
  ds.record('detectTypeJev', [...rows('shadow', 15), ...rows('fallback', 10, 'low-confidence')]);
  assert.equal(warns.length, 0, '10/25 = 40%: shadow é decisão aceita');
});

test('estágios são independentes: a tempestade de um não contamina o outro', () => {
  ds.record('linkPickJev', rows('fallback', 30, 'low-confidence'));
  ds.record('pageAssessJev', rows('accept', 30));
  const snap = ds.snapshot().byStage;
  assert.equal(snap.linkPickJev.storm, true);
  assert.equal(snap.pageAssessJev.storm, false);
  assert.equal(snap.pageAssessJev.windowRate, 0);
});

test('limites por env lidos NA HORA: JEV_STORM_RATE/JEV_STORM_WINDOW/JEV_STORM_MIN', () => {
  process.env.JEV_STORM_RATE = '0.9';
  ds.record('verifyRecordJev', [...rows('fallback', 40, 'low-confidence'), ...rows('accept', 10)]);
  assert.equal(warns.length, 0, '80% < 90%');
  ds.reset();
  process.env.JEV_STORM_RATE = '0.6';
  process.env.JEV_STORM_WINDOW = '10';
  process.env.JEV_STORM_MIN = '5';
  ds.record('verifyRecordJev', rows('fallback', 5, 'low-confidence'));
  assert.equal(warns.length, 1, 'janela curta: 5 decisões bastam');
  assert.equal(ds.snapshot().byStage.verifyRecordJev.windowSize, 5);
  ds.record('verifyRecordJev', rows('accept', 20));
  assert.equal(ds.snapshot().byStage.verifyRecordJev.windowSize, 10, 'janela limitada a JEV_STORM_WINDOW');
  process.env.JEV_STORM_RATE = 'lixo';
  ds.reset();
  ds.record('verifyRecordJev', rows('fallback', 5, 'low-confidence'));
  assert.equal(warns.length, 2, 'valor inválido cai no default (0.6)');
});
