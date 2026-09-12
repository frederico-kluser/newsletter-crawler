// Kept-blurb ENTRA NO STREAMING (src/crawl.js `keepAggregatorVersion`): o item curado cujo alvo
// não rendeu corpo fica com o blurb do agregador, mas SAI do enriquecimento (`needs_enrich = 0`)
// e devolve `{ verifyUrl }` — é esse retorno que o dispatch do crawl passa para `streamPostSave`,
// fazendo a ficha entrar em verify+resumo+classify NA MESMA RUN em vez de virar dívida para o
// sweep (ou para a run seguinte).
//
// Antes: ~400 pendentes migrando entre runs (docs/reprocesso-IA-audit-2026-09-11.md). A prova
// barata aqui é o par: (a) a linha ficou fora do enriquecimento, (b) a linha continua pendente de
// verify/resumo ESCOPADA À RUN — ou seja, o streaming vai alcançá-la.
//
// NC_HOME em tmpdir ANTES do import dinâmico (padrão do repo): importar crawl.js alcança db.js e
// abriria o banco real do usuário. crawl.js é importado DEPOIS do NC_HOME, nunca no topo.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-kept-blurb-'));
const { db, stmts } = await import('../src/db.js');
const { flushEvents } = await import('../src/events.js');
const { setLogSink } = await import('../src/util.js');
const { keepAggregatorVersion } = await import('../src/crawl.js');

setLogSink(() => {}); // keepAggregatorVersion loga uma linha por ficha — ruído no relatório do node:test

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

const src = stmts.upsertSource.get({
  name: 'KeptWeekly', base_url: 'https://kept.example', type: 'index', max_index_pages: null,
});

const RUN = 7;
const ISSUE = 'https://kept.example/issues/42';

/** Item CURADO como a curadoria cadastra: já nasce com o blurb do agregador e needs_enrich=1
 *  (o corpo do alvo é o enriquecimento), sem veredito e sem resumo. */
function seedCurated(url, title) {
  stmts.insertArticle.run({
    source_id: src.id, url, title, content: `${title} — blurb do agregador`,
    content_hash: `hash-${url}`, published_at: '2026-09-12', run_id: RUN, kind: 'news',
    issue_url: ISSUE, section: 'News', blurb: `${title} — blurb do agregador`,
    content_source: 'aggregator', cleaned: 0, needs_enrich: 1,
  });
  return stmts.getArticleFullByUrl.get(url);
}

const keptEventsFor = (url) =>
  stmts.listEventsForUrl.all(url, 100).filter((e) => e.stage === 'enrich' && e.status === 'kept-blurb');

test('keepAggregatorVersion: devolve { verifyUrl } e tira a ficha do enriquecimento', () => {
  const url = 'https://kept.example/alvo-raso';
  const row = seedCurated(url, 'Alvo raso');
  assert.equal(row.needs_enrich, 1, 'pré-condição: o item curado está no enriquecimento');

  const ret = keepAggregatorVersion(row, { runId: RUN, sourceId: src.id, url }, 'thin-content');
  assert.deepEqual(ret, { verifyUrl: url }, 'o retorno é a URL que o streamPostSave pós-processa');

  const depois = stmts.getArticleFullByUrl.get(url);
  assert.equal(depois.needs_enrich, 0, 'saiu do enriquecimento (não re-tenta o alvo raso)');
  assert.equal(depois.content, 'Alvo raso — blurb do agregador', 'o corpo é o blurb do agregador');
  assert.equal(depois.blurb, 'Alvo raso — blurb do agregador', 'a coluna blurb não é tocada');
  assert.equal(depois.kind, 'news', 'a curadoria (kind/section/issue_url) é preservada');
  assert.equal(depois.section, 'News');
  assert.equal(depois.issue_url, ISSUE);
  assert.equal(depois.published_at, '2026-09-12');
});

test('keepAggregatorVersion: grava o evento enrich/kept-blurb com run, fonte e motivo', () => {
  const url = 'https://kept.example/alvo-bloqueado';
  const row = seedCurated(url, 'Alvo bloqueado');

  keepAggregatorVersion(row, { runId: RUN, sourceId: src.id, url }, 'blocked-page');
  assert.ok(flushEvents() >= 1, 'o buffer de eventos (em lote) drena aqui');

  const evs = keptEventsFor(url);
  assert.equal(evs.length, 1, 'exatamente UM evento kept-blurb para a ficha');
  assert.equal(evs[0].run_id, RUN, 'a run fica no evento (ncrawl inspect filtra por ela)');
  assert.equal(evs[0].source_id, src.id);
  assert.deepEqual(JSON.parse(evs[0].detail), { reason: 'blocked-page' }, 'o motivo viaja no detail');
});

test('keepAggregatorVersion: o motivo é repassado verbatim (cada guard tem o seu)', () => {
  const casos = ['robots', 'pdf-target', 'error-page', 'json-page', 'dup-content', 'thin-content'];
  for (const [i, reason] of casos.entries()) {
    const url = `https://kept.example/motivo-${i}`;
    const row = seedCurated(url, `Item ${i}`);
    keepAggregatorVersion(row, { runId: RUN, sourceId: src.id, url }, reason);
    flushEvents();
    const evs = keptEventsFor(url);
    assert.equal(evs.length, 1, `evento único para o motivo ${reason}`);
    assert.deepEqual(JSON.parse(evs[0].detail), { reason });
    assert.equal(stmts.getArticleFullByUrl.get(url).needs_enrich, 0);
  }
});

test('item mantido com o blurb CONTINUA alcançável pelo sweep da própria run (o ponto do fix)', () => {
  const url = 'https://kept.example/alvo-streaming';
  const row = seedCurated(url, 'Alvo streaming');

  keepAggregatorVersion(row, { runId: RUN, sourceId: src.id, url }, 'thin-content');
  flushEvents();

  // verify_status/summary_pt seguem NULL e a run é a corrente: as três varreduras ESCOPADAS
  // enxergam a ficha. Se `keepAggregatorVersion` não devolvesse verifyUrl (ou o item sumisse do
  // escopo), o blurb só seria processado no sweep global/`finish` — a dívida entre runs.
  assert.ok(
    stmts.listArticlesToVerifyForRun.all(RUN, -1).some((r) => r.url === url),
    'verify da run alcança o item mantido',
  );
  assert.ok(
    stmts.listArticlesNeedingSummaryForRun.all(RUN, -1).some((r) => r.url === url),
    'resumo da run alcança o item mantido',
  );
  assert.ok(
    stmts.listArticlesNeedingClassificationForRun.all(RUN, -1).some((r) => r.url === url),
    'classificação da run alcança o item mantido',
  );
});

test('a linha do item mantido não reaparece como trabalho de enriquecimento pendente', () => {
  // O irmão que NÃO passou por keepAggregatorVersion continua com needs_enrich=1 (controle).
  const pendente = seedCurated('https://kept.example/ainda-pendente', 'Ainda pendente');
  assert.equal(pendente.needs_enrich, 1);
  const mantido = seedCurated('https://kept.example/mantido-controle', 'Mantido');
  keepAggregatorVersion(mantido, { runId: RUN, sourceId: src.id, url: mantido.url }, 'thin-content');
  flushEvents();

  assert.equal(stmts.getArticleFullByUrl.get(mantido.url).needs_enrich, 0);
  assert.equal(stmts.getArticleFullByUrl.get(pendente.url).needs_enrich, 1);
});

test('enriquecer CARIMBA a run corrente: a ficha entra no delta e no sweep escopado dela', () => {
  const url = 'https://kept.example/enriquecido-na-run-nova';
  const row = seedCurated(url, 'Enriquecido'); // cadastrado pela curadoria na RUN
  const RUN_NOVA = RUN + 2;

  // É o que o crawl faz ao ganhar o corpo do alvo (crawl.js: run_id: opts.runId): sem o carimbo,
  // a ficha enriquecida hoje mas criada na run N ficava invisível ao delta e ao sweep da run N+2.
  stmts.enrichArticle.run({
    id: row.id, run_id: RUN_NOVA, title: 'Enriquecido', content: 'corpo do alvo',
    content_hash: 'hash-corpo-alvo', published_at: '2026-09-12', content_source: 'target', cleaned: 1,
  });

  const depois = stmts.getArticleFullByUrl.get(url);
  assert.equal(depois.run_id, RUN_NOVA, 'a run do enriquecimento é a marca d’água do delta');
  assert.equal(depois.needs_enrich, 0);
  assert.equal(depois.content, 'corpo do alvo', 'o corpo do alvo substituiu o blurb');
  assert.equal(depois.content_source, 'target');
  for (const [nome, rows] of [
    ['verify', stmts.listArticlesToVerifyForRun.all(RUN_NOVA, -1)],
    ['resumo', stmts.listArticlesNeedingSummaryForRun.all(RUN_NOVA, -1)],
    ['classificação', stmts.listArticlesNeedingClassificationForRun.all(RUN_NOVA, -1)],
  ]) {
    assert.ok(rows.some((r) => r.url === url), `${nome} da run nova alcança a ficha enriquecida`);
  }
  assert.ok(
    !stmts.listArticlesNeedingSummaryForRun.all(RUN, -1).some((r) => r.url === url),
    'a run antiga não a reivindica mais (o carimbo é um só)',
  );

  // Retrocompatível: chamador antigo sem `run_id` PRESERVA a run gravada (coalesce no stmt).
  stmts.enrichArticle.run({
    id: row.id, title: 'Enriquecido', content: 'corpo 2', content_hash: 'hash-corpo-2',
    published_at: '2026-09-12', content_source: 'target', cleaned: 1,
  });
  assert.equal(stmts.getArticleFullByUrl.get(url).run_id, RUN_NOVA);
});
