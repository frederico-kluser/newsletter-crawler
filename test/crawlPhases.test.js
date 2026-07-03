// Derivação PURA das fases do crawl (src/ui/crawlPhases.js) a partir do snapshot vivo. Sem Ink:
// alimenta frontier+progress fabricados e confere estado/valor/contadores de cada fase e o badge
// global (preparando→coletando→finalizando→done/failed).
process.env.CRAWLER_LANG = '';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { derivePhases, deriveBadge } = await import('../src/ui/crawlPhases.js');

const byKey = (arr) => Object.fromEntries(arr.map((p) => [p.key, p]));

test('crawlPhases: badge preparando enquanto o progresso não está ativo', () => {
  assert.equal(deriveBadge({ frontier: {} }, { progress: { active: false } }, {}), 'preparando');
});

test('crawlPhases: coletando com descoberta/artigos em andamento; fases derivadas certas', () => {
  const frontier = { pending: 8, in_progress: 3, done: 34, failed: 1 };
  const progress = {
    active: true, since: '2026-06-25', pctGlobal: 73, sourcesTotal: 5, sourcesListingDone: 3,
    stages: { fetch: 3, render: 2 },
    counts: { salvos: 34, issues: 12, itensCurados: 89, verificados: 20, resumidos: 18, classificados: 22, mantidosBlurb: 4, estouros: 1 },
    sources: [],
  };
  assert.equal(deriveBadge({ frontier }, { progress }, {}), 'coletando');
  const ph = byKey(derivePhases({ frontier }, { progress }, {}));
  assert.equal(ph.discovery.state, 'active');
  assert.equal(ph.discovery.value, 60, '3/5 fontes = 60%');
  assert.equal(ph.curation.state, 'active', '12 issues já curadas → em andamento');
  assert.equal(ph.articles.state, 'active');
  assert.equal(ph.articles.value, 76, '(34+1)/(8+3+34+1) = 76%');
  assert.ok(ph.articles.counters.includes('34 salvos'));
  assert.ok(ph.articles.counters.includes('3 ativos'));
  assert.equal(ph.post.state, 'active');
  assert.equal(ph.post.value, 59, '20/34 = 59%');
});

test('crawlPhases: descoberta concluída, sem artigo em voo e pós ativo → finalizando', () => {
  const frontier = { pending: 0, in_progress: 0, done: 40, failed: 0 };
  const progress = {
    active: true, sourcesTotal: 5, sourcesListingDone: 5,
    stages: { verificação: 2 }, counts: { salvos: 40, verificados: 10 }, sources: [],
  };
  assert.equal(deriveBadge({ frontier }, { progress }, {}), 'finalizando');
  const ph = byKey(derivePhases({ frontier }, { progress }, {}));
  assert.equal(ph.discovery.state, 'done');
  assert.equal(ph.articles.state, 'done', 'fila zerada + descoberta done → artigos concluído');
});

test('crawlPhases: result define done/failed e conclui o pós', () => {
  const frontier = { pending: 0, in_progress: 0, done: 40, failed: 0 };
  const progress = { active: true, sourcesTotal: 2, sourcesListingDone: 2, stages: {}, counts: { salvos: 40, verificados: 40 }, sources: [] };
  assert.equal(deriveBadge({ frontier }, { progress }, { result: { ok: true } }), 'done');
  assert.equal(deriveBadge({ frontier }, { progress }, { result: { ok: false } }), 'failed');
  const ph = byKey(derivePhases({ frontier }, { progress }, { result: { ok: true } }));
  assert.equal(ph.post.state, 'done');
});

test('crawlPhases: sem issues de índice a linha de curadoria não aparece', () => {
  const frontier = { pending: 2, in_progress: 1, done: 5, failed: 0 };
  const progress = { active: true, sourcesTotal: 1, sourcesListingDone: 0, stages: { fetch: 1 }, counts: { salvos: 5 }, sources: [] };
  const keys = derivePhases({ frontier }, { progress }, {}).map((p) => p.key);
  assert.deepEqual(keys, ['discovery', 'articles', 'post'], 'sem curadoria quando não há issues');
});
