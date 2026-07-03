// Estimativa de custo pré-busca: seeds por tier, costHints do export e regra de confirmação
// (profunda SEMPRE confirma; soft só acima de softConfirm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateSearch } from '../src/lib/cost.js';

const SEARCH = {
  batchSize: 40,
  softConfirm: 4000,
  deepConfirm: 200,
  models: {
    searchBatch: { model: 'deepseek/deepseek-v4-flash', effort: 'xhigh' },
    searchRelevance: { model: 'deepseek/deepseek-v4-flash', effort: 'high' },
    fallback: { model: 'deepseek/deepseek-v4-pro' },
  },
  costHints: {},
};

test('soft: chamadas = ceil(count/batchSize), seed flash, confirma só acima do softConfirm', () => {
  const r = estimateSearch({ count: 600, deep: false, search: SEARCH });
  assert.equal(r.calls, 15);
  assert.ok(Math.abs(r.usd - 15 * 0.005) < 1e-9);
  assert.equal(r.needsConfirm, false);
  assert.equal(estimateSearch({ count: 4001, deep: false, search: SEARCH }).needsConfirm, true);
  assert.equal(estimateSearch({ count: 1, deep: false, search: SEARCH }).calls, 1);
});

test('profunda: 1 chamada por artigo e SEMPRE confirma', () => {
  const r = estimateSearch({ count: 3, deep: true, search: SEARCH });
  assert.equal(r.calls, 3);
  assert.equal(r.needsConfirm, true);
});

test('costHints do export (média real) têm precedência sobre o seed', () => {
  const s = { ...SEARCH, costHints: { searchBatch: 0.0031 } };
  const r = estimateSearch({ count: 80, deep: false, search: s });
  assert.ok(Math.abs(r.usd - 2 * 0.0031) < 1e-9);
});

test('modelo pro no estágio → seed 0.05', () => {
  const s = { ...SEARCH, models: { ...SEARCH.models, searchRelevance: { model: 'deepseek/deepseek-v4-pro' } } };
  const r = estimateSearch({ count: 2, deep: true, search: s });
  assert.ok(Math.abs(r.usd - 0.1) < 1e-9);
});
