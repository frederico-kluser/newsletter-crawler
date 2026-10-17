import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_FILTERS } from '../src/lib/filters.js';
import {
  DEFAULT_PAGE_SIZE,
  MAX_RESTORED_VISIBLE,
  loadViewState,
  resetViewState,
  sanitizeFilters,
  sanitizeScrollY,
  sanitizeVisibleCount,
  saveViewState,
} from '../src/lib/viewState.js';
import { setViewStateRaw } from '../src/lib/storage.js';

test('loadViewState: sem estado salvo retorna os defaults limpos e restored=false', () => {
  resetViewState();
  const st = loadViewState();
  assert.equal(st.restored, false);
  assert.deepEqual(st.filters, { ...EMPTY_FILTERS, facets: {} });
  assert.equal(st.textInput, '');
  assert.equal(st.visibleCount, DEFAULT_PAGE_SIZE);
  assert.equal(st.scrollY, 0);
  assert.equal(st.anchorId, null);
});

test('saveViewState + loadViewState: persiste e restaura filtros, busca local, paginação, scrollY e anchorId', () => {
  resetViewState();
  const saved = saveViewState({
    filters: {
      sourceIds: [2, 5, 2],
      from: '', // usuário limpou explicitamente o piso de data
      to: '2026-08-15',
      kind: 'tool',
      verify: 'ok',
      showJunk: true,
      facets: {
        domain: ['reactjs', 'nodejs', 'reactjs'],
        'topic-technology': ['agents'],
      },
    },
    textInput: 'mcp server',
    visibleCount: 96,
    scrollY: 1842.7,
    anchorId: 412,
  });
  assert.equal(saved, true);

  const restored = loadViewState();
  assert.equal(restored.restored, true);
  assert.deepEqual(restored.filters, {
    sourceIds: [2, 5],
    from: '',
    to: '2026-08-15',
    kind: 'tool',
    verify: 'ok',
    showJunk: true,
    facets: {
      domain: ['reactjs', 'nodejs'],
      'topic-technology': ['agents'],
    },
  });
  assert.equal(restored.textInput, 'mcp server');
  assert.equal(restored.visibleCount, 96);
  assert.equal(restored.scrollY, 1843);
  assert.equal(restored.anchorId, 412);
});

test('sanitizeFilters: entradas inválidas ou malformadas caem nos defaults seguros', () => {
  const clean = sanitizeFilters({
    sourceIds: ['abc', -1, 0, 3],
    from: 'data-invalida',
    to: '2026-13-99-extra',
    kind: 'inexistente',
    verify: 'qualquer',
    showJunk: 'sim',
    facets: {
      domain: ['llm', '', null, 42],
      vazio: [],
    },
  });
  assert.deepEqual(clean.sourceIds, [3]);
  assert.equal(clean.from, EMPTY_FILTERS.from);
  assert.equal(clean.to, EMPTY_FILTERS.to);
  assert.equal(clean.kind, 'all');
  assert.equal(clean.verify, '');
  assert.equal(clean.showJunk, false);
  assert.deepEqual(clean.facets, { domain: ['llm'] });
});

test('sanitizeVisibleCount e sanitizeScrollY: aplicam limites seguros', () => {
  assert.equal(sanitizeVisibleCount(undefined), DEFAULT_PAGE_SIZE);
  assert.equal(sanitizeVisibleCount(-10), DEFAULT_PAGE_SIZE);
  assert.equal(sanitizeVisibleCount(12), DEFAULT_PAGE_SIZE);
  assert.equal(sanitizeVisibleCount(72), 72);
  assert.equal(sanitizeVisibleCount(99999), MAX_RESTORED_VISIBLE);

  assert.equal(sanitizeScrollY(undefined), 0);
  assert.equal(sanitizeScrollY(-50), 0);
  assert.equal(sanitizeScrollY(420.4), 420);
});

test('loadViewState: JSON corrompido ou versão desconhecida falha aberto para o estado default', () => {
  setViewStateRaw('{json-quebrado');
  assert.equal(loadViewState().restored, false);

  setViewStateRaw(JSON.stringify({ v: 999, scrollY: 500 }));
  assert.equal(loadViewState().restored, false);
  resetViewState();
});
