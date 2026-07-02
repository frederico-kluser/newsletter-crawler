// Circuit breaker por host (fetch.js createBreaker): closed -> open após N falhas ->
// half-open após cooldown (1 probe única) -> fecha no ok / reabre dobrando o cooldown.
// Clock injetado — nada de sleep real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBreaker } from '../src/fetch.js';

const H = 'exemplo.com';

function mk(t0 = 0) {
  const clock = { t: t0 };
  const b = createBreaker({ now: () => clock.t, threshold: 3, baseCooldownMs: 1000, maxCooldownMs: 8000 });
  return { clock, b };
}

test('breaker: fecha por padrão e abre após N falhas consecutivas', () => {
  const { b } = mk();
  assert.equal(b.canRequest(H), true);
  b.recordError(H);
  b.recordError(H);
  assert.equal(b.canRequest(H), true); // ainda abaixo do threshold
  b.recordError(H);
  assert.equal(b.stateOf(H), 'open');
  assert.equal(b.canRequest(H), false);
});

test('breaker: ok zera a contagem (falhas precisam ser consecutivas)', () => {
  const { b } = mk();
  b.recordError(H);
  b.recordError(H);
  b.recordOk(H);
  b.recordError(H);
  b.recordError(H);
  assert.equal(b.stateOf(H), 'closed');
});

test('breaker: half-open após o cooldown admite UMA probe; sucesso fecha', () => {
  const { clock, b } = mk();
  for (let i = 0; i < 3; i++) b.recordError(H);
  assert.equal(b.canRequest(H), false);
  clock.t = 1000; // cooldown vencido
  assert.equal(b.canRequest(H), true); // a probe
  assert.equal(b.canRequest(H), false); // segunda tentativa espera a probe
  b.recordOk(H);
  assert.equal(b.stateOf(H), 'closed');
  assert.equal(b.canRequest(H), true);
});

test('breaker: probe falhando reabre DOBRANDO o cooldown (até o teto)', () => {
  const { clock, b } = mk();
  for (let i = 0; i < 3; i++) b.recordError(H);
  clock.t = 1000;
  assert.equal(b.canRequest(H), true); // probe 1
  b.recordError(H); // reabre com cooldown 2000
  assert.equal(b.stateOf(H), 'open');
  clock.t = 2500; // 1500 depois: ainda dentro dos 2000
  assert.equal(b.canRequest(H), false);
  clock.t = 3000; // 2000 depois da reabertura
  assert.equal(b.canRequest(H), true); // probe 2
  b.recordError(H); // cooldown 4000
  b.recordError(H);
  clock.t = 3000 + 4000;
  assert.equal(b.canRequest(H), true); // probe 3
  b.recordError(H); // cooldown 8000 = teto
  clock.t = 7000 + 8000;
  assert.equal(b.canRequest(H), true); // probe 4
  b.recordError(H); // teto: segue 8000, não 16000
  clock.t = 15000 + 8000;
  assert.equal(b.canRequest(H), true);
});

test('breaker: hosts são independentes', () => {
  const { b } = mk();
  for (let i = 0; i < 3; i++) b.recordError(H);
  assert.equal(b.canRequest(H), false);
  assert.equal(b.canRequest('outro.com'), true);
});
