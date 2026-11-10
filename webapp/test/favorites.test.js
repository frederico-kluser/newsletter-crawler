// Favoritos do webapp estático (localStorage via storage.js — em Node cai no Map da sessão,
// então dá p/ exercitar a lib pura). Toggle (devolve o estado novo), ordem novo→antigo,
// sanitização de ids no load, remoção/limpeza e o STORE (subscribe + snapshot com identidade
// estável entre mutações — o contrato do useSyncExternalStore).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearFavorites,
  getFavoritesSnapshot,
  isFavorite,
  loadFavorites,
  removeFavorite,
  subscribeFavorites,
  toggleFavorite,
} from '../src/lib/favorites.js';
import { trySetFavorites } from '../src/lib/storage.js';

beforeEach(() => clearFavorites());

test('toggleFavorite liga e desliga; loadFavorites devolve favoritados em ordem novo→antigo', () => {
  assert.equal(toggleFavorite(10), true); // ficou favorito
  assert.equal(toggleFavorite(22), true);
  assert.deepEqual(loadFavorites(), [22, 10]); // o mais recente primeiro
  assert.equal(toggleFavorite(10), false); // sai
  assert.deepEqual(loadFavorites(), [22]);
  assert.ok(isFavorite(22));
  assert.ok(!isFavorite(10));
});

test('toggle de id inválido não faz nada e devolve false', () => {
  for (const bad of [undefined, null, 0, -5, 3.7, 'x', NaN]) {
    assert.equal(toggleFavorite(bad), false);
  }
  assert.deepEqual(loadFavorites(), []);
});

test('loadFavorites sanitiza o payload salvo: ids não-inteiros/duplicados fora, ordem preservada', () => {
  trySetFavorites(JSON.stringify({ v: 1, ids: [7, 'abc', 7, -1, 0, 3.5, 42, null] }));
  assert.deepEqual(loadFavorites(), [7, 42]);
});

test('payload corrompido ou de versão desconhecida falha aberto para lista vazia', () => {
  trySetFavorites('{quebrado');
  assert.deepEqual(loadFavorites(), []);
  trySetFavorites(JSON.stringify({ v: 999, ids: [1] }));
  assert.deepEqual(loadFavorites(), []);
  trySetFavorites(JSON.stringify({ v: 1, ids: 'não-é-lista' }));
  assert.deepEqual(loadFavorites(), []);
});

test('removeFavorite é idempotente e clearFavorites esvazia', () => {
  toggleFavorite(1);
  toggleFavorite(2);
  assert.deepEqual(removeFavorite(1), [2]);
  assert.deepEqual(removeFavorite(1), [2]); // repetir não muda nada
  assert.deepEqual(clearFavorites(), []);
  assert.deepEqual(loadFavorites(), []);
});

test('store: subscribe recebe notificação por mutação; snapshot só troca de identidade ao mutar', () => {
  let calls = 0;
  const unsub = subscribeFavorites(() => {
    calls += 1;
  });
  const before = getFavoritesSnapshot();
  assert.equal(before.has(5), false);

  toggleFavorite(5);
  assert.equal(calls, 1);
  const after = getFavoritesSnapshot();
  assert.notEqual(after, before, 'mutação gera snapshot novo');
  assert.equal(after.has(5), true);
  assert.equal(getFavoritesSnapshot(), after, 'identidade estável entre mutações');

  toggleFavorite(5);
  assert.equal(calls, 2);
  assert.equal(getFavoritesSnapshot().has(5), false);

  unsub();
  toggleFavorite(5);
  assert.equal(calls, 2, 'cancelamento da inscrição funciona');
  clearFavorites();
});
