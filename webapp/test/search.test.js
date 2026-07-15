// Testes do motor de busca portado (lib pura): fusão tolerante de lote (espelha os casos de
// test/search.batch.test.js do CLI), chunking e clamps. Sem rede/DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCheckpoint, chunkBatches, clampKind, clampRelation, filterUnjudged, mergeBatchVerdicts, seedResume, toBatchItem } from '../src/lib/search.js';

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

// ---- retomada (checkpoint): pular o já julgado, semear e reconstruir o estado ----

test('filterUnjudged: mantém só os candidatos sem veredito', () => {
  const cands = [item(1), item(2), item(3), item(4)];
  const judged = new Set([2, 4]);
  assert.deepEqual(filterUnjudged(cands, judged).map((a) => a.id), [1, 3]);
});

test('seedResume: semeia verdicts (ids julgados), hits (clampados) e contadores', () => {
  const seeded = seedResume({
    judgedIds: [1, 2, 5],
    hits: [{ id: 2, relation: 'DIRECT', kind: 'TOOL' }, { id: 5, relation: 'banana', kind: 'x' }],
    scanned: 3, failed: 1, spentUsd: 0.01,
    spec: { query_en: 'q' },
  });
  assert.deepEqual([...seeded.verdicts.keys()], [1, 2, 5]);
  assert.equal(seeded.scanned, 3);
  assert.equal(seeded.failed, 1);
  assert.equal(seeded.spentUsd, 0.01);
  assert.deepEqual(seeded.hits, [
    { id: 2, relation: 'direct', kind: 'tool' },
    { id: 5, relation: 'none', kind: 'news' }, // fora do enum → clamp seguro
  ]);
  assert.deepEqual(seeded.spec, { query_en: 'q' });
});

test('seedResume: checkpoint vazio → acumuladores zerados (sem repagar nada… nem quebrar)', () => {
  const s = seedResume({});
  assert.equal(s.verdicts.size, 0);
  assert.deepEqual(s.hits, []);
  assert.equal(s.scanned, 0);
  assert.equal(s.failed, 0);
  assert.equal(s.spentUsd, 0);
  assert.equal(s.spec, null);
});

test('buildCheckpoint: judgedIds = todas as chaves de verdicts; relevant = nº de hits', () => {
  const verdicts = new Map([
    [1, { relation: 'none', kind: 'news' }],
    [2, { relation: 'direct', kind: 'tool' }],
    [3, { relation: 'none', kind: 'news' }],
  ]);
  const hits = [{ id: 2, relation: 'direct', kind: 'tool' }];
  const c = buildCheckpoint(verdicts, hits, { scanned: 3, failed: 0, total: 10, spentUsd: 0.002, spec: { query_en: 'q' } });
  assert.deepEqual(c.judgedIds, [1, 2, 3]);
  assert.deepEqual(c.hits, [{ id: 2, relation: 'direct', kind: 'tool' }]);
  assert.equal(c.relevant, 1);
  assert.equal(c.scanned, 3);
  assert.equal(c.total, 10);
  assert.equal(c.spentUsd, 0.002);
  assert.deepEqual(c.spec, { query_en: 'q' });
});

test('retomada NÃO repaga: candidates − judgedIds = só o que falta (seed→work→build)', () => {
  const all = [item(1), item(2), item(3), item(4)];
  const seeded = seedResume({ judgedIds: [1, 2], hits: [{ id: 1, relation: 'direct', kind: 'news' }], scanned: 2, spentUsd: 0.01 });
  const work = filterUnjudged(all, new Set(seeded.verdicts.keys()));
  assert.deepEqual(work.map((a) => a.id), [3, 4], 'só os não julgados entram na fila da retomada');
  // ao terminar [3,4], o checkpoint acumula os 4 julgados
  seeded.verdicts.set(3, { relation: 'none', kind: 'news' });
  seeded.verdicts.set(4, { relation: 'similar', kind: 'news' });
  const c = buildCheckpoint(seeded.verdicts, seeded.hits, { scanned: 4, failed: 0, total: 4, spentUsd: 0.02 });
  assert.deepEqual(c.judgedIds, [1, 2, 3, 4]);
});
