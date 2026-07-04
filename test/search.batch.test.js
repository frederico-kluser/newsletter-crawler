// Unidades PURAS do motor de busca em lote da web (sem rede/LLM): chunkBatches,
// mergeBatchVerdicts (fusão tolerante) e o clamp zod do juiz em lote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-batch-test-'));
process.env.NC_HOME = NC_HOME_TMP; // search.js importa db.js — o schema nasce num tmp
process.on('exit', () => rmSync(NC_HOME_TMP, { recursive: true, force: true }));

const { chunkBatches, mergeBatchVerdicts, prioritizeBySpec } = await import('../src/search.js');
const { relevanceBatchZ } = await import('../src/llm.js');

test('chunkBatches: divide preservando a ordem, resto no último lote', () => {
  const rows = Array.from({ length: 95 }, (_, i) => ({ id: i + 1 }));
  const batches = chunkBatches(rows, 40);
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((b) => b.length), [40, 40, 15]);
  assert.equal(batches[0][0].id, 1);
  assert.equal(batches[2].at(-1).id, 95);
  assert.deepEqual(chunkBatches([], 40), []);
  // size inválido não trava (clamp p/ 1)
  assert.equal(chunkBatches(rows.slice(0, 3), 0).length, 3);
});

test('mergeBatchVerdicts: faltando -> none (fail-open), desconhecido ignorado, duplicado 1º vence', () => {
  const batch = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const verdicts = new Map();
  const { missing, unknown } = mergeBatchVerdicts(
    batch,
    [
      { id: 2, relation: 'direct', kind: 'tool' },
      { id: 2, relation: 'none', kind: 'news' }, // duplicado: perde p/ o primeiro
      { id: 99, relation: 'direct', kind: 'news' }, // id inventado: ignorado
    ],
    verdicts,
  );
  assert.equal(missing, 2); // ids 1 e 3 sem veredito
  assert.equal(unknown, 1);
  assert.deepEqual(verdicts.get(1), { relation: 'none', kind: 'news' });
  assert.deepEqual(verdicts.get(2), { relation: 'direct', kind: 'tool' });
  assert.deepEqual(verdicts.get(3), { relation: 'none', kind: 'news' });
});

test('mergeBatchVerdicts: resposta nula/vazia vira tudo none sem lançar', () => {
  const verdicts = new Map();
  const { missing } = mergeBatchVerdicts([{ id: 7 }], null, verdicts);
  assert.equal(missing, 1);
  assert.equal(verdicts.get(7).relation, 'none');
});

test('relevanceBatchZ: clampa relation/kind desconhecidos e coage id string', () => {
  const parsed = relevanceBatchZ.parse({
    results: [
      { id: '12', relation: 'DIRECT', kind: 'Tool' }, // case + id string
      { id: 13, relation: 'banana', kind: 'library' }, // valores fora do vocabulário
    ],
  });
  assert.deepEqual(parsed.results[0], { id: 12, relation: 'direct', kind: 'tool' });
  assert.deepEqual(parsed.results[1], { id: 13, relation: 'none', kind: 'news' });
});

// ---- prioritizeBySpec (F4): ordena prováveis-hits primeiro pelos termos EN do spec ----
test('prioritizeBySpec: mais overlap de termos vem primeiro (varre tudo, só reordena)', () => {
  const spec = { terms: ['postgres', 'partitioning', 'database'], query_en: 'postgres partitioning' };
  const rows = [
    { id: 1, title: 'A CSS grid trick', summary_pt: 'sobre layout css' },
    { id: 2, title: 'pg_partman for Postgres partitioning', summary_pt: 'database partitioning extension' },
    { id: 3, title: 'Postgres arrays', summary_pt: 'database cost' },
  ];
  assert.deepEqual(prioritizeBySpec(rows, spec).map((r) => r.id), [2, 3, 1]);
  assert.equal(prioritizeBySpec(rows, spec).length, rows.length); // não descarta nada
});

test('prioritizeBySpec: sem spec/termos = no-op (ordem original preservada)', () => {
  const rows = [{ id: 5, title: 'x' }, { id: 4, title: 'y' }];
  assert.deepEqual(prioritizeBySpec(rows, null).map((r) => r.id), [5, 4]);
  assert.deepEqual(prioritizeBySpec(rows, { terms: [] }).map((r) => r.id), [5, 4]);
  assert.deepEqual(prioritizeBySpec(rows, { terms: ['react'] }).map((r) => r.id), [5, 4]); // 1 termo = sinal fraco
});

test('prioritizeBySpec: empate de score mantém a ordem original (estável)', () => {
  const spec = { terms: ['react', 'component'] };
  const rows = [{ id: 9, title: 'react component' }, { id: 8, title: 'react component' }];
  assert.deepEqual(prioritizeBySpec(rows, spec).map((r) => r.id), [9, 8]);
});
