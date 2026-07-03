// Testes do motor de busca portado (lib pura): fusão tolerante de lote (espelha os casos de
// test/search.batch.test.js do CLI), chunking e clamps. Sem rede/DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkBatches, clampKind, clampRelation, mergeBatchVerdicts, toBatchItem } from '../src/lib/search.js';

const item = (id) => ({ id, title: `t${id}`, summary: `s${id}` });

test('mergeBatchVerdicts: id faltando vira none (fail-open); desconhecido é ignorado; duplicado 1º vence', () => {
  const batch = [item(1), item(2), item(3)];
  const verdicts = new Map();
  const { missing, unknown } = mergeBatchVerdicts(
    batch,
    [
      { id: 1, relation: 'direct', kind: 'tool' },
      { id: 1, relation: 'none', kind: 'news' }, // duplicado: NÃO sobrescreve o 1º
      { id: 99, relation: 'direct', kind: 'news' }, // id inventado: ignorado
      // id 2 e 3 omitidos → none
    ],
    verdicts,
  );
  assert.deepEqual(verdicts.get(1), { relation: 'direct', kind: 'tool' });
  assert.deepEqual(verdicts.get(2), { relation: 'none', kind: 'news' });
  assert.deepEqual(verdicts.get(3), { relation: 'none', kind: 'news' });
  assert.equal(missing, 2);
  assert.equal(unknown, 1);
});

test('mergeBatchVerdicts: id ecoado como STRING é coagido; valores fora do enum são clampados', () => {
  const batch = [item(7)];
  const verdicts = new Map();
  mergeBatchVerdicts(batch, [{ id: '7', relation: 'DIRECT', kind: 'banana' }], verdicts);
  assert.deepEqual(verdicts.get(7), { relation: 'direct', kind: 'news' });
});

test('mergeBatchVerdicts: resposta nula/não-array não derruba (tudo vira none)', () => {
  const batch = [item(1), item(2)];
  const verdicts = new Map();
  const { missing } = mergeBatchVerdicts(batch, null, verdicts);
  assert.equal(missing, 2);
  assert.deepEqual(verdicts.get(1), { relation: 'none', kind: 'news' });
});

test('chunkBatches preserva ordem e reparte por tamanho (mínimo 1)', () => {
  const rows = [1, 2, 3, 4, 5].map(item);
  assert.deepEqual(chunkBatches(rows, 2).map((b) => b.map((x) => x.id)), [[1, 2], [3, 4], [5]]);
  assert.equal(chunkBatches(rows, 0).length, 5); // size inválido → lotes de 1
  assert.equal(chunkBatches([], 40).length, 0);
});

test('clamps: relation/kind fora do vocabulário caem no default seguro', () => {
  assert.equal(clampRelation('Similar'), 'similar');
  assert.equal(clampRelation('foo'), 'none');
  assert.equal(clampKind('TOOL'), 'tool');
  assert.equal(clampKind(undefined), 'news');
});

test('toBatchItem: usa summary_pt > snippet, normaliza whitespace e corta em 400/200', () => {
  const a = { id: 1, title: 'x'.repeat(300), title_pt: null, summary_pt: null, snippet: '  a\n\nb   c  ' };
  const it = toBatchItem(a);
  assert.equal(it.title.length, 200);
  assert.equal(it.summary, 'a b c');
  const b = { id: 2, title: 't', summary_pt: 'resumo pt', snippet: 'ignorado' };
  assert.equal(toBatchItem(b).summary, 'resumo pt');
  const vazio = { id: 3, title: '', title_pt: '', summary_pt: '', snippet: '' };
  assert.equal(toBatchItem(vazio).title, '');
  assert.equal(toBatchItem(vazio).summary, '');
});
