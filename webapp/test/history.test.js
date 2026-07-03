// Histórico de buscas do webapp estático (localStorage via storage.js — em Node cai no Map da
// sessão, então dá p/ exercitar a lib pura). Congelamento (ids+vereditos), ordem novo→antigo,
// unicidade de id mesmo no mesmo ms, remover e limpar.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { addToHistory, loadHistory, removeFromHistory, clearHistory } from '../src/lib/history.js';

beforeEach(() => clearHistory());

const result = (over = {}) => ({
  query: 'react server components',
  deep: false,
  scanned: 40,
  total: 40,
  relevant: 2,
  failed: 0,
  truncated: false,
  spentUsd: 0.0021,
  hits: [
    { id: 10, relation: 'direct', kind: 'news' },
    { id: 22, relation: 'similar', kind: 'tool' },
  ],
  ...over,
});

test('addToHistory congela a busca e loadHistory devolve novo→antigo', () => {
  addToHistory(result({ query: 'primeira' }), { sourceId: 3, from: '2026-06-01', to: '' });
  addToHistory(result({ query: 'segunda', deep: true }), {});
  const list = loadHistory();
  assert.equal(list.length, 2);
  assert.equal(list[0].query, 'segunda'); // a mais recente no topo
  assert.equal(list[0].deep, true);
  const first = list[1];
  assert.equal(first.query, 'primeira');
  assert.deepEqual(first.scope, { sourceId: 3, from: '2026-06-01', to: '' });
  assert.equal(first.stats.relevant, 2);
  assert.equal(first.stats.spentUsd, 0.0021);
  // hits guardam SÓ id+relation+kind (leves; a ficha é re-hidratada na restauração)
  assert.deepEqual(first.hits, [
    { id: 10, relation: 'direct', kind: 'news' },
    { id: 22, relation: 'similar', kind: 'tool' },
  ]);
});

test('ids são únicos mesmo em saves consecutivos (mesmo ms)', () => {
  for (let i = 0; i < 5; i++) addToHistory(result({ query: `q${i}` }), {});
  const ids = loadHistory().map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'nenhum id repetido');
});

test('removeFromHistory tira só o item pedido', () => {
  addToHistory(result({ query: 'fica' }), {});
  const list = addToHistory(result({ query: 'sai' }), {});
  const alvo = list.find((e) => e.query === 'sai');
  const after = removeFromHistory(alvo.id);
  assert.equal(after.length, 1);
  assert.equal(after[0].query, 'fica');
  assert.equal(loadHistory().length, 1);
});

test('clearHistory esvazia', () => {
  addToHistory(result(), {});
  assert.equal(clearHistory().length, 0);
  assert.equal(loadHistory().length, 0);
});

test('scope ausente vira campos vazios (nunca undefined)', () => {
  addToHistory(result(), undefined);
  const e = loadHistory()[0];
  assert.deepEqual(e.scope, { sourceId: null, from: '', to: '' });
});
