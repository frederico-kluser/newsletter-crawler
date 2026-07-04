// Regressão do bug do `finish`: com a internet fora, a API não responde e o artigo era gravado
// como 'classificado' sem tags (falso-positivo) — e nunca mais re-selecionado. O fix mantém o
// artigo PENDENTE (não persiste) quando uma faceta OBRIGATÓRIA cai por rede/API. Aqui testamos o
// helper puro `failedMandatoryFacets`, que é o critério exato dessa decisão.
// NC_HOME temporário ANTES do import (classify.js -> db.js abre o banco no load).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-classify-'));
const { failedMandatoryFacets } = await import('../src/classify.js');

after(() => rmSync(process.env.NC_HOME, { recursive: true, force: true }));

// Espelha config/taxonomy.json: obrigatórias = domain, content-type, topic-technology.
const FACETS = [
  { name: 'domain', mandatory: true },
  { name: 'content-type', mandatory: true },
  { name: 'topic-technology', mandatory: true },
  { name: 'difficulty', mandatory: false },
  { name: 'ecosystem-language', mandatory: false },
  { name: 'concept-theme', mandatory: false },
];
// ok=false só para as facetas nomeadas em `down`; o resto responde (ok:true).
const results = (down = []) =>
  FACETS.map((f) => ({ facet: f.name, ok: !down.includes(f.name) }));

test('queda TOTAL de rede (todas as facetas ok:false) => incompleto — cenário das 185 vítimas', () => {
  const failed = failedMandatoryFacets(FACETS.map((f) => ({ facet: f.name, ok: false })), FACETS);
  assert.deepEqual(new Set(failed), new Set(['domain', 'content-type', 'topic-technology']));
});

test('uma faceta obrigatória (domain) caiu, resto ok => incompleto (mantém pendente)', () => {
  assert.deepEqual(failedMandatoryFacets(results(['domain']), FACETS), ['domain']);
});

test('só facetas NÃO-obrigatórias caíram => NÃO é incompleto (persiste como parcial)', () => {
  assert.deepEqual(failedMandatoryFacets(results(['difficulty', 'concept-theme']), FACETS), []);
});

test('faceta obrigatória VAZIA de verdade (ok:true) => NÃO é incompleto (não re-classifica p/ sempre)', () => {
  // o LLM respondeu, só não achou tag — resultado real de baixa qualidade; deve persistir uma vez.
  assert.deepEqual(failedMandatoryFacets(results([]), FACETS), []);
});

test('lista de resultados vazia (defensivo) => nenhuma obrigatória falhou', () => {
  assert.deepEqual(failedMandatoryFacets([], FACETS), []);
});
