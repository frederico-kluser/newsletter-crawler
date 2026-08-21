// Teto de tentativas de ENRIQUECIMENTO: alvo que falhou N rodadas seguidas (frontier
// state='failed') para de ser re-enfileirado no início do crawl — o item curado fica com o
// blurb do agregador (fail-open) em vez de a run inteira re-falhar os mesmos alvos mortos
// (domínio NXDOMAIN, PDF sem handler) a cada execução. Exercita os stmts do db.js:
// bumpFailedEnrichAttempts (conta a rodada falhada), requeueNeedsEnrichForSource (só re-ativa
// quem tem tentativa) e countEnrichAtCapForSource (feed do log "no teto").
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
  assert.equal(re.changes, 3); // a, c, d
  assert.equal(capped, 1); // só b (falhou E no teto; e está done, não conta)
});

test('bump conta só frontier failed do MESMO source; needs_enrich=0 não é tocado', () => {
  const src = stmts.upsertSource.get({ name: 'Outra', base_url: 'https://outra.example', type: 'index', max_index_pages: 1 });
  const sid = src.id;
  seedArticle({ url: 'https://outra.example/done', sourceId: sid, attempts: 0, state: 'done' }); // done não conta falha
  seedArticle({ url: 'https://outra.example/full', sourceId: sid, needsEnrich: 0, attempts: 0, state: 'failed' }); // já enriquecido
  stmts.bumpFailedEnrichAttempts.run(sid);
  assert.equal(attemptsOf('https://outra.example/done'), 0);
  assert.equal(attemptsOf('https://outra.example/full'), 0);
});

test('countEnrichAtCapForSource só conta quem está no teto E com frontier failed', () => {
  const src = stmts.upsertSource.get({ name: 'Terceira', base_url: 'https://terceira.example', type: 'index', max_index_pages: 1 });
  const sid = src.id;
  seedArticle({ url: 'https://terceira.example/falhou', sourceId: sid, attempts: CAP, state: 'failed' });
  seedArticle({ url: 'https://terceira.example/done', sourceId: sid, attempts: CAP, state: 'done' });
  seedArticle({ url: 'https://terceira.example/abaixo', sourceId: sid, attempts: 1, state: 'failed' });
  assert.equal(stmts.countEnrichAtCapForSource.get(sid, CAP).c, 1);
});
