// Camada de MARCOS da run (src/run-events.js): assinatura dispara já + a cada emit + para no unsub;
// canal ticker substitui no lugar (não entra no feed); coalescing de rajada idêntica vira count;
// ring respeita o teto; reset zera feed/ticker/warnCount. Módulo puro — sem Ink/DB.
process.env.CRAWLER_LANG = '';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { emitRunEvent, runEventsReset, subscribeRunEvents, bumpWarnCount } = await import('../src/run-events.js');

test('run-events: subscribe dispara com o snapshot atual, notifica no emit e para após unsub', () => {
  runEventsReset();
  const snaps = [];
  const unsub = subscribeRunEvents((s) => snaps.push(s));
  assert.equal(snaps.length, 1, 'dispara imediatamente');
  assert.equal(snaps[0].feed.length, 0, 'feed começa vazio');
  emitRunEvent({ phase: 'discovery', kind: 'source-done', source: 'X' });
  assert.equal(snaps.length, 2, 'notifica no emit');
  assert.equal(snaps.at(-1).feed.length, 1, 'evento entrou no feed');
  unsub();
  emitRunEvent({ phase: 'discovery', kind: 'source-done', source: 'Y' });
  assert.equal(snaps.length, 2, 'após unsub não notifica mais');
});

test('run-events: canal ticker substitui no lugar; o feed acumula os marcos', () => {
  runEventsReset();
  let snap = null;
  const unsub = subscribeRunEvents((s) => (snap = s));
  emitRunEvent({ kind: 'saved', channel: 'ticker', detail: 'A' });
  emitRunEvent({ kind: 'saved', channel: 'ticker', detail: 'B' });
  assert.equal(snap.feed.length, 0, 'ticker NÃO entra no feed');
  assert.equal(snap.ticker.detail, 'B', 'ticker fica com o último salvo');
  emitRunEvent({ kind: 'issue-curated', source: 'T', detail: '7 itens' });
  assert.equal(snap.feed.length, 1, 'marco de feed acumula');
  unsub();
});

test('run-events: rajada idêntica coalesce em count; detail diferente não', () => {
  runEventsReset();
  let snap = null;
  const unsub = subscribeRunEvents((s) => (snap = s));
  emitRunEvent({ phase: 'articles', kind: 'kept-blurb', detail: 'raso' });
  emitRunEvent({ phase: 'articles', kind: 'kept-blurb', detail: 'raso' });
  emitRunEvent({ phase: 'articles', kind: 'kept-blurb', detail: 'raso' });
  assert.equal(snap.feed.length, 1, 'coalesce numa linha só');
  assert.equal(snap.feed[0].count, 3, 'conta a rajada');
  emitRunEvent({ phase: 'articles', kind: 'kept-blurb', detail: 'outro' });
  assert.equal(snap.feed.length, 2, 'detail diferente abre nova linha');
  unsub();
});

test('run-events: ring respeita o teto (<=100); reset zera feed/ticker/warnCount', () => {
  runEventsReset();
  let snap = null;
  const unsub = subscribeRunEvents((s) => (snap = s));
  for (let i = 0; i < 130; i++) emitRunEvent({ phase: 'x', kind: 'source-done', source: `s${i}` });
  assert.ok(snap.feed.length <= 100, `feed limitado a 100, veio ${snap.feed.length}`);
  emitRunEvent({ kind: 'saved', channel: 'ticker', detail: 'z' });
  bumpWarnCount(5);
  assert.equal(snap.warnCount, 5, 'avisos internos contados');
  runEventsReset();
  assert.equal(snap.feed.length, 0, 'reset zera o feed');
  assert.equal(snap.ticker, null, 'reset zera o ticker');
  assert.equal(snap.warnCount, 0, 'reset zera o contador de avisos');
  unsub();
});
