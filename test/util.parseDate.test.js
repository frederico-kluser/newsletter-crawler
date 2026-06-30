// Eval do parser de datas: traduz as strings reais (Readability/LLM/JSON-LD) em Date
// comparável. Rode com: npm test  (node --test, sem dependências extras).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate } from '../src/util.js';

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

test('parseDate: comparação de piso (--since, fronteira inclusiva)', () => {
  const since = parseDate('2026-06-25');
  assert.ok(parseDate('2026-06-29') >= since, 'mais novo: mantém');
  assert.ok(parseDate('2026-06-25T00:00:00+00:00') >= since, 'fronteira: mantém (inclusiva)');
  assert.ok(parseDate('2026-06-24') < since, 'mais antigo: corta');
});
