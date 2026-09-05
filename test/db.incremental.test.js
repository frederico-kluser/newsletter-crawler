// Incrementalidade da camada de dados: o predicado `isUrlKnown` (consumido pela parada
// determinística de paginação em crawl.js) e a marca d'água `run_id` no ENRIQUECIMENTO.
//   - isUrlKnown só aceitava frontier state='done', então um link já DESCOBERTO mas ainda
//     'pending'/'failed' contava como NOVO. Efeito real da correção: a parada por território
//     conhecido dispara uma página ANTES (antes do upsertPage e do dateSeen/floorHit) e
//     sobrevive a uma frontier apagada. NÃO é a diferença entre parar e caminhar o arquivo
//     inteiro: `crawlArchive` já parava com `added === 0` na página seguinte, e `enqueue`
//     sempre foi INSERT OR IGNORE sobre linha existente.
//   - enrichArticle não tocava run_id, então o item cadastrado só com o blurb na run N e
//     enriquecido na run N+1 continuava com run_id=N e sumia do escopo "apenas o novo".
// ESCOPO destes testes: os stmts do db.js. O LAÇO que soma o predicado e decide o `break` mora
// em crawl.js (fetch de rede) e não é exercitado aqui.
// NC_HOME em tmpdir ANTES de importar db (padrão do repo) — o banco real do usuário nunca é aberto.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-db-incremental-'));
const { db, stmts } = await import('../src/db.js');
const { sha256 } = await import('../src/util.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

const known = (url) => Boolean(stmts.isUrlKnown.get(url, url, url, url));

function seedFrontier(url, state, { kind = 'article', sourceId = null } = {}) {
  stmts.enqueue.run(url, kind, null, sourceId, 0, null);
  db.prepare('UPDATE frontier SET state = ? WHERE url = ?').run(state, url);
}

function seedArticle({ url, sourceId = null, issueUrl = null, runId = null, needsEnrich = 0 }) {
  stmts.insertArticle.run({
    source_id: sourceId, url, title: 'T', content: 'c-' + url, content_hash: sha256('c-' + url),
    published_at: '2026-01-01', run_id: runId, kind: 'news', issue_url: issueUrl, section: null,
    blurb: 'blurb', content_source: needsEnrich ? 'aggregator' : 'target', cleaned: 0,
    needs_enrich: needsEnrich,
  });
  return stmts.getArticleByUrl.get(url).id;
}

// ---- isUrlKnown ----

test('isUrlKnown: URL nunca vista NÃO é conhecida', () => {
  assert.equal(known('https://novo.example/nunca-vista'), false);
});

test('isUrlKnown: artigo salvo, página visitada e issue de origem contam', () => {
  seedArticle({ url: 'https://k.example/artigo', issueUrl: 'https://k.example/issue/1' });
  stmts.upsertPage.run({
    source_id: null, url: 'https://k.example/listagem', html_hash: 'h', status: 'done',
    pagination_depth: 0,
  });
  assert.equal(known('https://k.example/artigo'), true);
  assert.equal(known('https://k.example/listagem'), true);
  assert.equal(known('https://k.example/issue/1'), true); // casa por articles.issue_url
});

test('isUrlKnown: os QUATRO estados da frontier contam, não só done (o bug)', () => {
  seedFrontier('https://f.example/done', 'done');
  seedFrontier('https://f.example/failed', 'failed');
  seedFrontier('https://f.example/pending', 'pending');
  seedFrontier('https://f.example/inprogress', 'in_progress');
  assert.equal(known('https://f.example/done'), true);
  assert.equal(known('https://f.example/failed'), true, 'failed = abandonado de propósito, é conhecido');
  assert.equal(known('https://f.example/pending'), true, 'pending = já está na fila desta run');
  assert.equal(known('https://f.example/inprogress'), true, 'in_progress = reivindicado agora');
});

// Nada se perde ao pular o enfileiramento de uma URL "conhecida": `enqueue` é INSERT OR IGNORE,
// então para uma URL que já tem linha na frontier (em QUALQUER estado) ele já era no-op — e o
// estado anterior (inclusive retries) fica intacto. É a prova de F1.
test('enqueue de URL já na frontier é no-op em qualquer estado (nada se perde ao pulá-lo)', () => {
  for (const state of ['pending', 'in_progress', 'done', 'failed']) {
    const url = `https://noop.example/${state}`;
    seedFrontier(url, state);
    db.prepare('UPDATE frontier SET retries = 2 WHERE url = ?').run(url);
    const again = stmts.enqueue.run(url, 'article', 'https://noop.example/', 1, 0, null);
    const row = db.prepare('SELECT state, retries FROM frontier WHERE url = ?').get(url);
    assert.equal(again.changes, 0, `enqueue deveria ser no-op em ${state}`);
    assert.equal(row.state, state);
    assert.equal(row.retries, 2);
  }
});

// O laço de crawl.js soma `isUrlKnown` sobre os links da página e para quando o total bate com
// `dated.length`. Este teste NÃO roda esse laço (ele faz fetch de rede): fixa só o CONTRATO de
// entrada que ele consome — o predicado tem de ser verdadeiro para link já descoberto de
// qualquer forma (article OU frontier pending/failed) e FALSO para link inédito, senão a soma do
// laço dá um falso-positivo (para cedo demais) ou um falso-negativo (nunca para).
test('isUrlKnown discrimina página 100% conhecida de página com link inédito', () => {
  const links = ['https://pag.example/1', 'https://pag.example/2', 'https://pag.example/3'];
  seedFrontier(links[0], 'pending');
  seedFrontier(links[1], 'failed');
  seedArticle({ url: links[2] });
  assert.equal(links.filter(known).length, links.length, 'nenhum falso-negativo: os 3 casam');

  // Um único link realmente novo derruba a igualdade -> o laço NÃO pode parar (falso-positivo).
  const comNovo = [...links, 'https://pag.example/4-novo'];
  assert.equal(comNovo.filter(known).length, comNovo.length - 1);
});

// ---- enrichArticle: marca d'água do delta ----

test('enrichArticle carimba a run corrente quando run_id é passado', () => {
  const id = seedArticle({ url: 'https://e.example/item', runId: 7, needsEnrich: 1 });
  stmts.enrichArticle.run({
    id, title: 'Título curado', content: 'corpo do alvo', content_hash: sha256('corpo do alvo'),
    published_at: '2026-02-02', content_source: 'target', cleaned: 1, run_id: 9,
  });
  const row = stmts.getArticleFullByUrl.get('https://e.example/item');
  assert.equal(row.run_id, 9, 'o item enriquecido entra no delta da run que o enriqueceu');
  assert.equal(row.needs_enrich, 0);
  assert.equal(row.content, 'corpo do alvo');
  assert.equal(row.kind, 'news'); // curadoria intacta
  assert.equal(row.blurb, 'blurb');
  // e o delta por run passa a enxergá-lo
  const naRun9 = stmts.listRunArticlesForSearch.all(9, -1).map((a) => a.url);
  assert.ok(naRun9.includes('https://e.example/item'));
});

test('enrichArticle SEM run_id preserva o valor atual (retrocompatível com crawl.js)', () => {
  const id = seedArticle({ url: 'https://e.example/legado', runId: 4, needsEnrich: 1 });
  stmts.enrichArticle.run({
    id, title: 'T', content: 'corpo', content_hash: sha256('corpo-legado'),
    published_at: null, content_source: 'target', cleaned: 1,
  });
  const row = stmts.getArticleFullByUrl.get('https://e.example/legado');
  assert.equal(row.run_id, 4, 'sem o campo, coalesce mantém o run_id antigo — nada quebra');
  assert.equal(row.needs_enrich, 0);
});

test('enrichArticle com run_id null explícito também preserva', () => {
  const id = seedArticle({ url: 'https://e.example/nulo', runId: 5, needsEnrich: 1 });
  stmts.enrichArticle.run({
    id, title: 'T', content: 'corpo2', content_hash: sha256('corpo2'),
    published_at: null, content_source: 'target', cleaned: 1, run_id: null,
  });
  assert.equal(stmts.getArticleFullByUrl.get('https://e.example/nulo').run_id, 5);
});
