// filterSeedSources (--sources "A,B"): sem flag -> todas; item casa por nome exato
// case-insensitive OU URL normalizada; trim em volta das vírgulas; itens sem match saem em
// unmatched. NC_HOME temporário ANTES do import (commands.js -> db.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-sources-'));
const { filterSeedSources } = await import('../src/commands.js');
const { db } = await import('../src/db.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

const SOURCES = [
  { name: 'Node Weekly', url: 'https://nodeweekly.com/issues', type: 'index' },
  { name: 'Postgres Weekly', url: 'https://postgresweekly.com/issues', type: 'index' },
  { url: 'https://golangweekly.com/issues', type: 'index' }, // sem name: label é a URL
];

test('sem flag (ou flag booleana) -> todas as fontes, sem unmatched', () => {
  for (const flags of [{}, { sources: true }, { sources: '' }, { sources: '  ,  ' }]) {
    const { selected, unmatched } = filterSeedSources(SOURCES, flags);
    assert.deepEqual(selected, SOURCES);
    assert.deepEqual(unmatched, []);
  }
});

test('nome exato casa case-insensitive; substring NÃO casa', () => {
  const { selected, unmatched } = filterSeedSources(SOURCES, { sources: 'node weekly' });
  assert.deepEqual(selected.map((s) => s.name), ['Node Weekly']);
  assert.deepEqual(unmatched, []);
  const sub = filterSeedSources(SOURCES, { sources: 'Weekly' });
  assert.deepEqual(sub.selected, []);
  assert.deepEqual(sub.unmatched, ['Weekly']);
});

test('URL casa via normalizeUrl (barra final/hash irrelevantes) mesmo sem name', () => {
  const { selected } = filterSeedSources(SOURCES, { sources: 'https://golangweekly.com/issues/' });
  assert.deepEqual(selected.map((s) => s.url), ['https://golangweekly.com/issues']);
});

test('lista por vírgula com espaços: trim por item; ordem do config preservada', () => {
  const { selected, unmatched } = filterSeedSources(SOURCES, {
    sources: ' Postgres Weekly ,  Node Weekly ,, ',
  });
  assert.deepEqual(selected.map((s) => s.name), ['Node Weekly', 'Postgres Weekly']);
  assert.deepEqual(unmatched, []);
});

test('itens sem match vão para unmatched (e não derrubam os válidos)', () => {
  const { selected, unmatched } = filterSeedSources(SOURCES, {
    sources: 'Node Weekly, Fonte Fantasma, https://nao-existe.example.com/issues',
  });
  assert.deepEqual(selected.map((s) => s.name), ['Node Weekly']);
  assert.deepEqual(unmatched, ['Fonte Fantasma', 'https://nao-existe.example.com/issues']);
});
