// Decisão pura de parada do scroll (scrollRoundDecision): platô no modo simples (artigo);
// no modo collect (listagem/scroll infinito) NÃO confia na altura — para por 'piso' (--since)
// ou 'estagnado' (N checagens sem link novo). NC_HOME temporário ANTES do import (config.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-scroll-'));
const { scrollRoundDecision } = await import('../src/fetch.js');

after(() => {
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

const DAY = 86_400_000;
const SINCE = Date.parse('2026-06-25T00:00:00Z');

test('modo simples (artigo): para no platô de altura, segue quando cresce', () => {
  assert.equal(scrollRoundDecision({ collect: false, heightGrew: true }).stop, null);
  assert.equal(scrollRoundDecision({ collect: false, heightGrew: false }).stop, 'plateau');
});

test('collect: platô de altura sozinho NÃO para (feed virtualizado recicla DOM)', () => {
  const d = scrollRoundDecision({ collect: true, heightGrew: false, newCount: 5, stall: 0, stallChecks: 3 });
  assert.equal(d.stop, null);
  assert.equal(d.stall, 0);
});

test('collect: estagna após stallChecks checagens seguidas sem link novo; link novo zera', () => {
  let stall = 0;
  let d;
  d = scrollRoundDecision({ collect: true, newCount: 0, stall, stallChecks: 3 });
  assert.equal(d.stop, null);
  stall = d.stall;
  d = scrollRoundDecision({ collect: true, newCount: 0, stall, stallChecks: 3 });
  assert.equal(d.stop, null);
  stall = d.stall;
  d = scrollRoundDecision({ collect: true, newCount: 0, stall, stallChecks: 3 });
  assert.equal(d.stop, 'estagnado');

  // um link novo no meio zera a contagem
  d = scrollRoundDecision({ collect: true, newCount: 3, stall: 2, stallChecks: 3 });
  assert.equal(d.stop, null);
  assert.equal(d.stall, 0);
});

test('collect + --since: para por piso quando >= 2 itens novos datados e TODOS abaixo do alvo', () => {
  const abaixo = [SINCE - 2 * DAY, SINCE - 5 * DAY];
  const d = scrollRoundDecision({ collect: true, newCount: 2, newDatesMs: abaixo, sinceMs: SINCE, stall: 0 });
  assert.equal(d.stop, 'piso');
});

test('piso NÃO dispara com 1 data só (defesa contra datetime podre) nem com item ainda no range', () => {
  assert.equal(
    scrollRoundDecision({ collect: true, newCount: 1, newDatesMs: [SINCE - DAY], sinceMs: SINCE, stall: 0 }).stop,
    null,
  );
  assert.equal(
    scrollRoundDecision({
      collect: true, newCount: 2, newDatesMs: [SINCE - DAY, SINCE + DAY], sinceMs: SINCE, stall: 0,
    }).stop,
    null,
  );
});

test('sem --since não há piso: só estagnação/teto param o collect', () => {
  const d = scrollRoundDecision({ collect: true, newCount: 2, newDatesMs: [SINCE - DAY, SINCE - DAY], sinceMs: null, stall: 0 });
  assert.equal(d.stop, null);
});
