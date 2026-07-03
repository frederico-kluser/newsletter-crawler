// CrawlDashboard (painel do crawl) renderizado com props injetadas (sem DB/Ink real): confere o
// cabeçalho+badge+cronômetro, a tabela de fases com rótulos+barras, o ticker "salvo", a faixa de
// métricas, o feed curado (marcos com rótulo PT + tag de fonte), o rodapé com o contador de avisos
// e o toggle do overlay verbose. Componente PURO (dados por props), então o teste não roda thunk.
process.env.CRAWLER_LANG = ''; // asserts em PT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';

const { html } = await import('../src/ui/html.js');
const { CrawlDashboard } = await import('../src/ui/CrawlDashboard.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const status = { frontier: { pending: 8, in_progress: 3, done: 34, failed: 1 }, articles: 34, classified: 22 };
const tele = {
  governor: {
    ram: { totalBytes: 1, usedPct: 61, state: 'ok' },
    lanes: { llm: { active: 12, capacity: 16 }, fetch: { active: 3, capacity: 8 }, render: { active: 2, capacity: 8 } },
  },
  budget: { spentUsd: 0.42, budgetUsd: 2, calls: 128, reservedUsd: 0, byStage: { curadoria: { costUsd: 0.21 } } },
  progress: {
    active: true, since: '2026-06-25', pctGlobal: 73, sourcesTotal: 5, sourcesListingDone: 3,
    stages: { fetch: 3, render: 2 },
    counts: { salvos: 34, issues: 12, itensCurados: 89, verificados: 20, resumidos: 18, classificados: 22, mantidosBlurb: 4, estouros: 1 },
    sources: [{ id: 1, name: 'TechCrunch', pct: 40, floorHit: false }, { id: 2, name: 'TLDR', pct: 100, floorHit: true }],
  },
};
const feed = [
  { id: 1, at: 1751544199000, phase: 'curation', kind: 'issue-curated', level: 'success', source: 'TLDR', detail: '7 itens' },
  { id: 2, at: 1751544190000, phase: 'articles', kind: 'timeout', level: 'warn', detail: 'https://verge.com/x' },
];
const ticker = { id: 3, kind: 'saved', detail: 'Novo modelo da OpenAI lança' };

test('UI/dashboard: cabeçalho, fases, ticker, métricas, feed curado e rodapé', async () => {
  const { lastFrame, unmount } = render(html`<${CrawlDashboard}
    status=${status} tele=${tele} feed=${feed} ticker=${ticker} warnCount=${3}
    verbose=${false} rawLines=${[]} elapsedMs=${134000} result=${null}
  />`);
  await wait(40);
  const frame = lastFrame() || '';
  // cabeçalho + badge de estado + cronômetro
  assert.ok(frame.includes('Coleta'), `título\n${frame}`);
  assert.ok(/coletando/i.test(frame), 'badge de estado (Badge deixa em maiúsculas)');
  assert.ok(frame.includes('02:14'), 'cronômetro mm:ss (134s)');
  // tabela de fases
  assert.ok(frame.includes('Descoberta'), 'fase descoberta');
  assert.ok(frame.includes('Curadoria'), 'fase curadoria');
  assert.ok(frame.includes('Artigos'), 'fase artigos');
  assert.ok(frame.includes('Pós-proc.'), 'fase pós');
  assert.ok(frame.includes('3/5 fontes'), 'contador da descoberta');
  assert.ok(frame.includes('34 salvos'), 'contador de artigos');
  // ticker "salvo" no lugar
  assert.ok(frame.includes('Novo modelo da OpenAI'), 'ticker do último salvo');
  // % por data e métricas
  assert.ok(frame.includes('2026-06-25'), 'linha da data-alvo');
  assert.ok(frame.includes('US$ 0.42/2.00'), 'faixa de métricas');
  // feed curado: rótulos PT + tag de fonte
  assert.ok(frame.includes('eventos'), 'régua do feed');
  assert.ok(frame.includes('coletânea curada'), 'marco issue-curated em PT');
  assert.ok(frame.includes('[TLDR]'), 'tag de fonte no feed');
  assert.ok(frame.includes('tempo esgotado'), 'marco timeout em PT');
  // rodapé: avisos internos colapsados + atalhos
  assert.ok(frame.includes('3 avisos internos'), 'contador de avisos');
  assert.ok(frame.includes('v detalhes'), 'atalhos no rodapé');
  unmount();
});

test('UI/dashboard: overlay verbose (v) mostra o log cru', async () => {
  const { lastFrame, unmount } = render(html`<${CrawlDashboard}
    status=${status} tele=${tele} feed=${feed} ticker=${null} warnCount=${1}
    verbose=${true} rawLines=${[{ level: 'warn', text: 'parse-pool: worker morreu' }]} elapsedMs=${1000} result=${null}
  />`);
  await wait(40);
  const frame = lastFrame() || '';
  assert.ok(frame.includes('log bruto'), 'título do overlay');
  assert.ok(frame.includes('parse-pool: worker morreu'), 'linha de log cru no overlay');
  unmount();
});

test('UI/dashboard: run concluída mostra badge Concluído', async () => {
  const { lastFrame, unmount } = render(html`<${CrawlDashboard}
    status=${status} tele=${tele} feed=${[]} ticker=${null} warnCount=${0}
    verbose=${false} rawLines=${[]} elapsedMs=${5000} result=${{ ok: true }}
  />`);
  await wait(40);
  const frame = lastFrame() || '';
  assert.ok(/conclu[íi]do/i.test(frame), `badge concluído\n${frame}`);
  unmount();
});
