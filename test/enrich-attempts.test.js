// Teto de tentativas de ENRIQUECIMENTO: alvo que falhou N rodadas seguidas para de ser
// re-enfileirado no início do crawl — o item curado fica com o blurb do agregador (fail-open)
// em vez de a run inteira re-falhar os mesmos alvos mortos (domínio NXDOMAIN, PDF sem handler)
// a cada execução. Exercita os stmts do db.js: bumpFailedEnrichAttempts (conta a rodada
// falhada), requeueNeedsEnrichForSource (só re-ativa quem tem tentativa) e
// countEnrichAtCapForSource (feed do log "no teto").
//
// A RODADA FALHADA é `needs_enrich = 1` + job TERMINADO — frontier 'done' OU 'failed', não só
// 'failed'. O ramo de TIMEOUT do job grava 'done' (commands.js: a ficha fica com o blurb e
// re-enfileira depois) e requeueNeedsEnrichForSource re-ativa done E failed: contando só
// 'failed', um alvo que SEMPRE estoura o deadline era re-enfileirado para sempre com
// enrich_attempts congelado em 0 e o teto nunca chegava. As asserções abaixo que antes
// documentavam o ramo 'done' como não-contado documentavam o BUG.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-enrich-attempts-'));
const { db, stmts } = await import('../src/db.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

const CAP = 3;
const frontierState = db.prepare('SELECT state FROM frontier WHERE url = ?');
const attemptsOf = (url) => stmts.getArticleFullByUrl.get(url)?.enrich_attempts ?? null;

function seedArticle({ url, sourceId, state, needsEnrich = 1, attempts = 0 }) {
  stmts.insertArticle.run({
    source_id: sourceId, url, title: 'Título', content: 'blurb', content_hash: 'h-' + url,
    published_at: null, run_id: null, kind: 'news', issue_url: null, section: null,
    blurb: 'blurb', content_source: 'aggregator', cleaned: 0, needs_enrich: needsEnrich ? 1 : 0,
  });
  stmts.enqueue.run(url, 'article', null, sourceId, 0, null);
  stmts.finish.run(state, url);
  if (attempts > 0) db.prepare('UPDATE articles SET enrich_attempts = ? WHERE url = ?').run(attempts, url);
}

test('requeue com teto: fresh re-enfileira; no teto fica parado; done também re-enfileira', () => {
  const src = stmts.upsertSource.get({ name: 'Fonte', base_url: 'https://fonte.example', type: 'index', max_index_pages: 1 });
  const sid = src.id;
  // a: nunca tentou (attempts 0) e falhou -> re-enfileira
  seedArticle({ url: 'https://fonte.example/a', sourceId: sid, attempts: 0, state: 'failed' });
  // b: no teto (attempts 3) e falhou -> NÃO re-enfileira
  seedArticle({ url: 'https://fonte.example/b', sourceId: sid, attempts: CAP, state: 'failed' });
  // c: tentativa restante (attempts 1; o bump conta 2 e ainda fica < 3) -> re-enfileira
  seedArticle({ url: 'https://fonte.example/c', sourceId: sid, attempts: CAP - 2, state: 'failed' });
  // d: done (alvo renderizou mas não rendeu corpo — ex.: deadline) -> re-enfileira
  seedArticle({ url: 'https://fonte.example/d', sourceId: sid, attempts: 0, state: 'done' });
  // e: no teto mas state done -> não re-enfileira
  seedArticle({ url: 'https://fonte.example/e', sourceId: sid, attempts: CAP, state: 'done' });

  stmts.bumpFailedEnrichAttempts.run(sid);
  const re = stmts.requeueNeedsEnrichForSource.run(sid, CAP);
  const capped = stmts.countEnrichAtCapForSource.get(sid, CAP).c;

  assert.equal(attemptsOf('https://fonte.example/a'), 1); // bump conta a rodada falhada
  assert.equal(frontierState.get('https://fonte.example/a').state, 'pending'); // fresh: volta
  assert.equal(attemptsOf('https://fonte.example/b'), CAP + 1); // bump contabiliza mesmo no teto
  assert.equal(frontierState.get('https://fonte.example/b').state, 'failed'); // no teto: parado
  assert.equal(attemptsOf('https://fonte.example/c'), CAP - 1); // bump: 1 -> 2
  assert.equal(frontierState.get('https://fonte.example/c').state, 'pending'); // ainda < teto
  assert.equal(frontierState.get('https://fonte.example/d').state, 'pending'); // done também volta
  assert.equal(frontierState.get('https://fonte.example/e').state, 'done'); // no teto: parado
  assert.equal(attemptsOf('https://fonte.example/d'), 1); // done também é rodada falhada (timeout)
  assert.equal(attemptsOf('https://fonte.example/e'), CAP + 1); // bump contabiliza mesmo no teto
  assert.equal(re.changes, 3); // a, c, d
  assert.equal(capped, 2); // b e e: ambos no teto com o job já terminado (failed/done)
});

test('bump conta done E failed (job terminado sem corpo); pending/outra fonte/enriquecido não', () => {
  const src = stmts.upsertSource.get({ name: 'Outra', base_url: 'https://outra.example', type: 'index', max_index_pages: 1 });
  const sid = src.id;
  seedArticle({ url: 'https://outra.example/done', sourceId: sid, attempts: 0, state: 'done' }); // timeout: conta
  seedArticle({ url: 'https://outra.example/failed', sourceId: sid, attempts: 0, state: 'failed' }); // retries: conta
  seedArticle({ url: 'https://outra.example/full', sourceId: sid, needsEnrich: 0, attempts: 0, state: 'failed' }); // já enriquecido
  // Ainda na FILA (nunca foi tentado, ou devolvido por BUDGET_EXCEEDED / resetInProgress):
  // não houve rodada falhada, então o contador NÃO pode andar.
  seedArticle({ url: 'https://outra.example/pending', sourceId: sid, attempts: 0, state: 'pending' });
  seedArticle({ url: 'https://outra.example/inprogress', sourceId: sid, attempts: 0, state: 'in_progress' });
  // Outra fonte: fora do escopo do bump (source_id = ?).
  const other = stmts.upsertSource.get({ name: 'Vizinha', base_url: 'https://vizinha.example', type: 'index', max_index_pages: 1 });
  seedArticle({ url: 'https://vizinha.example/failed', sourceId: other.id, attempts: 0, state: 'failed' });

  stmts.bumpFailedEnrichAttempts.run(sid);

  assert.equal(attemptsOf('https://outra.example/done'), 1); // done = timeout: É rodada falhada
  assert.equal(attemptsOf('https://outra.example/failed'), 1);
  assert.equal(attemptsOf('https://outra.example/full'), 0); // needs_enrich=0: fora do fluxo
  assert.equal(attemptsOf('https://outra.example/pending'), 0); // na fila: nada a contar
  assert.equal(attemptsOf('https://outra.example/inprogress'), 0); // em voo: nada a contar
  assert.equal(attemptsOf('https://vizinha.example/failed'), 0); // outra fonte
});

test('countEnrichAtCapForSource conta quem está no teto com o job terminado (done ou failed)', () => {
  const src = stmts.upsertSource.get({ name: 'Terceira', base_url: 'https://terceira.example', type: 'index', max_index_pages: 1 });
  const sid = src.id;
  seedArticle({ url: 'https://terceira.example/falhou', sourceId: sid, attempts: CAP, state: 'failed' });
  seedArticle({ url: 'https://terceira.example/done', sourceId: sid, attempts: CAP, state: 'done' });
  seedArticle({ url: 'https://terceira.example/abaixo', sourceId: sid, attempts: 1, state: 'failed' });
  seedArticle({ url: 'https://terceira.example/fila', sourceId: sid, attempts: CAP, state: 'pending' });
  // falhou + done: no teto e sem job vivo (é o que o log reporta como "mantido com o blurb").
  // 'abaixo' ainda tem tentativa; 'fila' está enfileirado (o requeue não precisou agir nele).
  assert.equal(stmts.countEnrichAtCapForSource.get(sid, CAP).c, 2);
});
