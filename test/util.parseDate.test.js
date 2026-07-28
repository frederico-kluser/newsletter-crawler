// Eval do parser de datas: traduz as strings reais (Readability/LLM/JSON-LD) em Date
// comparável. Rode com: npm test  (node --test, sem dependências extras).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampFutureDate, parseDate } from '../src/util.js';

test('parseDate: ISO-8601 com Z e milissegundos', () => {
  assert.equal(parseDate('2026-06-24T12:50:56.000Z').toISOString(), '2026-06-24T12:50:56.000Z');
});

test('parseDate: ISO-8601 com offset de fuso', () => {
  assert.equal(parseDate('2024-07-08T22:23:27+00:00').toISOString(), '2024-07-08T22:23:27.000Z');
});

test('parseDate: date-only YYYY-MM-DD vira meia-noite UTC', () => {
  assert.equal(parseDate('2026-06-25').toISOString(), '2026-06-25T00:00:00.000Z');
});

test('parseDate: null/undefined/vazio/inválido -> null', () => {
  assert.equal(parseDate(null), null);
  assert.equal(parseDate(undefined), null);
  assert.equal(parseDate('   '), null);
  assert.equal(parseDate('not a date'), null);
});

test('clampFutureDate: data além de hoje+1d vira a data de hoje; o resto passa intacto', () => {
  const hoje = new Date('2026-07-28T10:00:00.000Z');
  // o caso real que motivou a trava: item do Node Weekly datado 25 dias à frente
  assert.equal(clampFutureDate('2026-08-22', hoje), '2026-07-28');
  assert.equal(clampFutureDate('2026-07-28', hoje), '2026-07-28', 'hoje: intacto');
  assert.equal(clampFutureDate('2026-07-29', hoje), '2026-07-29', 'amanhã: dentro da tolerância de fuso');
  assert.equal(clampFutureDate('2026-07-30', hoje), '2026-07-28', 'depois de amanhã: crava hoje');
  assert.equal(clampFutureDate('June 18, 2026', hoje), 'June 18, 2026', 'string crua do scrape: preservada');
});

test('clampFutureDate: valor inparseável/vazio volta como veio (fail-open)', () => {
  const hoje = new Date('2026-07-28T10:00:00.000Z');
  assert.equal(clampFutureDate(null, hoje), null);
  assert.equal(clampFutureDate(undefined, hoje), undefined);
  assert.equal(clampFutureDate('', hoje), '');
  assert.equal(clampFutureDate('not a date', hoje), 'not a date');
});

test('parseDate: comparação de piso (--since, fronteira inclusiva)', () => {
  const since = parseDate('2026-06-25');
  assert.ok(parseDate('2026-06-29') >= since, 'mais novo: mantém');
  assert.ok(parseDate('2026-06-25T00:00:00+00:00') >= since, 'fronteira: mantém (inclusiva)');
  assert.ok(parseDate('2026-06-24') < since, 'mais antigo: corta');
});
