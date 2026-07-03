// Busca de texto local: fold de acentos, termos AND, campos cobertos, consulta vazia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHaystack, fold, matchesText, searchText, termsOf } from '../src/lib/textSearch.js';

const art = (over = {}) => ({
  id: 1,
  title: 'React Server Components deep dive',
  title_pt: 'Mergulho em React Server Components',
  summary_pt: 'Como os RSC mudam a renderização.',
  snippet: '',
  section: 'Top Stories',
  source_name: 'Node Weekly',
  tags: { domain: ['reactjs'], 'content-type': ['deep-dive'] },
  ...over,
});

test('fold remove acentos e baixa a caixa', () => {
  assert.equal(fold('Época NÃO Ç'), 'epoca nao c');
  assert.equal(fold(null), '');
});

test('acento-insensível: "epoca" casa "Época"', () => {
  const a = art({ title: 'Época nova para LLMs', title_pt: null, summary_pt: null, tags: {} });
  assert.ok(matchesText(a, termsOf('epoca')));
  assert.ok(matchesText(a, termsOf('ÉPOCA')));
});

test('termos AND: todos precisam aparecer (em qualquer campo)', () => {
  const a = art();
  assert.ok(matchesText(a, termsOf('react components'))); // ambos no título
  assert.ok(matchesText(a, termsOf('react weekly'))); // um no título, outro na fonte
  assert.ok(matchesText(a, termsOf('reactjs renderização'))); // um na tag, outro no resumo
  assert.ok(!matchesText(a, termsOf('react vue'))); // "vue" não existe → não casa
});

test('cobre tags, seção e fonte além de título/resumo', () => {
  const a = art();
  assert.ok(matchesText(a, termsOf('deep-dive'))); // tag content-type
  assert.ok(matchesText(a, termsOf('top stories'))); // seção
  assert.ok(matchesText(a, termsOf('node'))); // fonte
});

test('consulta vazia casa tudo; searchText filtra a lista', () => {
  const list = [art({ id: 1 }), art({ id: 2, title: 'Vitest 3', title_pt: null, summary_pt: null, tags: {}, source_name: 'JS Weekly', section: null })];
  assert.equal(searchText(list, '').length, 2);
  assert.equal(searchText(list, '   ').length, 2);
  assert.deepEqual(searchText(list, 'vitest').map((a) => a.id), [2]);
  assert.deepEqual(searchText(list, 'react').map((a) => a.id), [1]);
});

test('usa o _search pré-computado quando presente (paridade com buildHaystack)', () => {
  const a = art();
  const withPre = { ...a, _search: buildHaystack(a) };
  assert.ok(matchesText(withPre, termsOf('mergulho')));
  // _search desatualizado é o que vale (prova que o pré-computado é usado)
  const stale = { ...a, _search: 'somente-isso' };
  assert.ok(matchesText(stale, termsOf('somente-isso')));
  assert.ok(!matchesText(stale, termsOf('react')));
});
