// Checkpoint da busca EM ANDAMENTO (localStorage via storage.js — em Node cai no Map da sessão, dá
// p/ exercitar a lib pura). Round-trip, slot único, fail-open (versão/corrupção/quota), independência
// do histórico, e o writer com throttle de borda-de-ataque (tempo injetável).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearActiveSearch, loadActiveSearch, makeCheckpointWriter, saveActiveSearch } from '../src/lib/activeSearch.js';
import { trySetActive } from '../src/lib/storage.js';
import { addToHistory, clearHistory, loadHistory } from '../src/lib/history.js';

beforeEach(() => {
  clearActiveSearch();
  clearHistory();
});

const cp = (over = {}) => ({
  query: 'llm inference',
  deep: false,
  scope: { sourceId: null, from: '', to: '' },
  spec: { must_have: ['x'], nice_to_have: [], query_en: 'llm inference', terms: ['inference'] },
  judgedIds: [1, 2, 3],
  hits: [{ id: 2, relation: 'direct', kind: 'tool' }],
  scanned: 3,
  relevant: 1,
  failed: 0,
  total: 10,
  spentUsd: 0.004,
  ...over,
});

test('save→load faz round-trip do checkpoint (com v:1)', () => {
  assert.equal(loadActiveSearch(), null);
  saveActiveSearch(cp());
  const got = loadActiveSearch();
  assert.equal(got.v, 1);
  assert.equal(got.query, 'llm inference');
  assert.deepEqual(got.judgedIds, [1, 2, 3]);
  assert.deepEqual(got.hits, [{ id: 2, relation: 'direct', kind: 'tool' }]);
  assert.equal(got.spentUsd, 0.004);
});

test('slot ÚNICO: um novo save sobrescreve o anterior', () => {
  saveActiveSearch(cp({ query: 'primeira' }));
  saveActiveSearch(cp({ query: 'segunda', judgedIds: [9] }));
  const got = loadActiveSearch();
  assert.equal(got.query, 'segunda');
  assert.deepEqual(got.judgedIds, [9]);
});

test('clearActiveSearch remove o checkpoint', () => {
  saveActiveSearch(cp());
  clearActiveSearch();
  assert.equal(loadActiveSearch(), null);
});

test('corrupção / versão diferente / sem query → null (fail-open)', () => {
  trySetActive('{ não é json');
  assert.equal(loadActiveSearch(), null);
  trySetActive(JSON.stringify({ v: 2, query: 'x' })); // versão futura
  assert.equal(loadActiveSearch(), null);
  trySetActive(JSON.stringify({ v: 1 })); // sem query
  assert.equal(loadActiveSearch(), null);
});

test('quota cheia → saveActiveSearch retorna false sem lançar', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const quotaErr = new Error('quota');
  quotaErr.name = 'QuotaExceededError';
  globalThis.localStorage = { setItem() { throw quotaErr; }, getItem() { return null; }, removeItem() {} };
  try {
    assert.equal(saveActiveSearch(cp()), false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});

test('busca ativa (nc-search-active) e histórico (nc-search-history) são independentes', () => {
  saveActiveSearch(cp({ query: 'ativa' }));
  addToHistory({ query: 'concluida', deep: false, scanned: 1, total: 1, relevant: 0, failed: 0, truncated: false, spentUsd: 0, hits: [] }, {});
  assert.equal(loadActiveSearch().query, 'ativa');
  assert.equal(loadHistory()[0].query, 'concluida');
  clearActiveSearch();
  assert.equal(loadActiveSearch(), null);
  assert.equal(loadHistory().length, 1, 'limpar a busca ativa NÃO mexe no histórico');
});

test('makeCheckpointWriter: 1ª escrita imediata, throttle na janela, flush força, cancel descarta', () => {
  let clock = 1000;
  const writes = [];
  const w = makeCheckpointWriter({ minMs: 1200, now: () => clock, write: (v) => writes.push(v) });
  const build = (tag) => () => ({ tag });

  w.push(build('a')); // t=1000, borda-de-ataque → grava
  assert.deepEqual(writes, [{ tag: 'a' }]);
  w.push(build('b')); // dentro da janela → NÃO grava
  assert.equal(writes.length, 1);
  clock = 2100; // +1100 desde o último write ainda < 1200
  w.push(build('c'));
  assert.equal(writes.length, 1);
  clock = 2300; // ≥1200 desde 1000 → grava o MAIS novo
  w.push(build('d'));
  assert.deepEqual(writes[1], { tag: 'd' });
  clock = 2350;
  w.push(build('e')); // janela desde 2300 → pendente
  assert.equal(writes.length, 2);
  w.flush(); // força o pendente
  assert.deepEqual(writes[2], { tag: 'e' });
  w.push(build('f')); // pendente
  w.cancel(); // descarta
  w.flush();
  assert.equal(writes.length, 3, 'cancel jogou fora o pendente');
});

test('makeCheckpointWriter: o build (thunk) só é materializado quando de fato grava', () => {
  let clock = 0;
  let builds = 0;
  const w = makeCheckpointWriter({ minMs: 1000, now: () => clock, write: () => {} });
  const build = () => {
    builds += 1;
    return {};
  };
  w.push(build); // grava (borda-de-ataque) → builds=1
  w.push(build); // janela → não grava → não materializa
  w.push(build); // idem
  assert.equal(builds, 1, 'thunks deferidos não são chamados');
});
