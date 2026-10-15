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
    jobsBase: { done: 30, failed: 0 },
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
  assert.equal(ph.articles.value, 31, 'fila da RUN: (34−30)+(1−0)=5 terminais sobre 5+8+3=16');
  assert.ok(ph.articles.counters.includes('34 salvos'));
  assert.ok(ph.articles.counters.includes('3 ativos'));
  assert.equal(ph.post.state, 'active');
  assert.equal(ph.post.value, 59, '20/34 = 59%');
});

test('crawlPhases: barra de Artigos é da run, não do frontier global; sem jobsBase não há barra', () => {
  // O caso da captura: 19 266 artigos de runs antigas no frontier, 25 jobs em voo e 0 salvos —
  // a barra pelo frontier global nascia 100% cheia. Com o jobsBase (base pós-seed) o delta da
  // run é 0 → 0%.
  const frontier = { pending: 0, in_progress: 25, done: 19266, failed: 0 };
  const progress = {
    active: true, sourcesTotal: 11, sourcesListingDone: 7,
    jobsBase: { done: 19266, failed: 0 },
    stages: { fetch: 11, curadoria: 1 },
    counts: { salvos: 0 }, sources: [],
  };
  const ph = byKey(derivePhases({ frontier }, { progress }, {}));
  assert.equal(ph.articles.value, 0, '0 terminais na run sobre 25 em voo → 0%');
  assert.ok(ph.articles.counters.includes('0 salvos'));
  assert.ok(ph.articles.counters.includes('25 ativos'));
  assert.equal(ph.articles.state, 'active');
  // Sem a base pós-seed não dá para medir a run: a barra SOME em vez de mentir.
  const sem = byKey(derivePhases({ frontier }, { progress: { ...progress, jobsBase: null } }, {}));
  assert.equal(sem.articles.value, null, 'sem jobsBase → sem barra');
  // E a run avança: 10 dos 25 terminam → 40%.
  const depois = byKey(
    derivePhases(
      { frontier: { pending: 0, in_progress: 15, done: 19276, failed: 0 } },
      { progress: { ...progress, counts: { salvos: 10 } } },
      {},
    ),
  );
  assert.equal(depois.articles.value, 40, '10 terminais sobre 25 da run');
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
