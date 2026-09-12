// Sweep pós-crawl ESCOPADO POR RUN (src/db.js + verify/summarize/classify): os três statements
// `listArticles*ForRun` filtram `run_id = ?` e as funções `*Pending({ runId })` usam o escopado
// quando `runId != null` e o global quando `runId == null` (o caminho do `finish`, que drena a
// dívida de TODAS as runs).
//
// Por que isso importa (medido em docs/reprocesso-IA-audit-2026-09-11.md): uma coleta de data já
// coberta não pode drenar ~400 fichas pendentes de runs anteriores — o backlog é do `finish`
// explícito. O par de asserções "escopado = só a minha run / global = todas" é o contrato.
//
// As funções async são exercitadas SÓ no caso em que o escopo devolve zero linhas (run 99): elas
// retornam antes de qualquer chamada de LLM, então o teste prova o DISPATCH (se o runId fosse
// ignorado, o stmt global acharia pendentes e cairia na rede) sem tocar em rede/LLM.
//
// NC_HOME em tmpdir ANTES do import dinâmico (padrão do repo) — banco real nunca é aberto.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-sweep-scope-'));
const { db, stmts } = await import('../src/db.js');
const { setLogSink } = await import('../src/util.js');
const { verifyPending } = await import('../src/verify.js');
const { summarizePending } = await import('../src/summarize.js');
const { classifyPending } = await import('../src/classify.js');

setLogSink(() => {}); // as funções *Pending logam o "nada a fazer" — ruído no relatório do node:test

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

const src = stmts.upsertSource.get({
  name: 'SweepWeekly', base_url: 'https://sweep.example', type: 'index', max_index_pages: null,
});

/** Artigo pendente de tudo (verify_status NULL, summary_pt NULL, sem classification). */
function seed(url, runId) {
  stmts.insertArticle.run({
    source_id: src.id, url, title: 'Item', content: 'corpo do item', content_hash: `hash-${url}`,
    published_at: '2026-09-12', run_id: runId, kind: 'news', issue_url: null, section: null,
    blurb: 'blurb', content_source: 'aggregator', cleaned: 0, needs_enrich: 0,
  });
  return stmts.getArticleFullByUrl.get(url).id;
}

const RUN1 = 'https://sweep.example/run-1';
const RUN2 = 'https://sweep.example/run-2';
const id1 = seed(RUN1, 1);
const id2 = seed(RUN2, 2);

const urls = (rows) => rows.map((r) => r.url).sort();
const ids = (rows) => rows.map((r) => r.id).sort((a, b) => a - b);

// ---- os três statements escopados ----

test('listArticlesToVerifyForRun: só a run pedida; o global devolve as duas', () => {
  assert.deepEqual(urls(stmts.listArticlesToVerifyForRun.all(1, -1)), [RUN1]);
  assert.deepEqual(urls(stmts.listArticlesToVerifyForRun.all(2, -1)), [RUN2]);
  assert.deepEqual(urls(stmts.listArticlesToVerifyForRun.all(99, -1)), [], 'run sem fichas -> vazio');
  assert.deepEqual(urls(stmts.listArticlesToVerify.all(-1)), [RUN1, RUN2], 'global = todas as pendentes');
  // o LIMIT continua valendo no escopado (mesma ordem por id do global)
  assert.equal(stmts.listArticlesToVerifyForRun.all(1, 1).length, 1);
  assert.deepEqual(stmts.listArticlesToVerifyForRun.all(1, 1).map((r) => r.url), [RUN1]);
});

test('listArticlesNeedingSummaryForRun: só a run pedida; o global devolve as duas', () => {
  assert.deepEqual(urls(stmts.listArticlesNeedingSummaryForRun.all(1, -1)), [RUN1]);
  assert.deepEqual(urls(stmts.listArticlesNeedingSummaryForRun.all(2, -1)), [RUN2]);
  assert.deepEqual(urls(stmts.listArticlesNeedingSummaryForRun.all(99, -1)), []);
  assert.deepEqual(urls(stmts.listArticlesNeedingSummary.all(-1)), [RUN1, RUN2]);
  assert.equal(stmts.listArticlesNeedingSummaryForRun.all(2, 1).length, 1);
});

test('listArticlesNeedingClassificationForRun: só a run pedida; o global devolve as duas', () => {
  assert.deepEqual(urls(stmts.listArticlesNeedingClassificationForRun.all(1, -1)), [RUN1]);
  assert.deepEqual(urls(stmts.listArticlesNeedingClassificationForRun.all(2, -1)), [RUN2]);
  assert.deepEqual(urls(stmts.listArticlesNeedingClassificationForRun.all(99, -1)), []);
  assert.deepEqual(urls(stmts.listArticlesNeedingClassification.all(-1)), [RUN1, RUN2]);
  assert.equal(stmts.listArticlesNeedingClassificationForRun.all(1, 1).length, 1);
});

// ---- o filtro de PENDÊNCIA continua valendo dentro do escopo ----

test('escopo por run NÃO relaxa o filtro de pendência (ficha já processada fica fora)', () => {
  const jaFeita = 'https://sweep.example/run-3-pronta';
  const pendente = 'https://sweep.example/run-3-pendente';
  const idPronta = seed(jaFeita, 3);
  seed(pendente, 3);

  stmts.setVerify.run({ id: idPronta, verify_status: 'ok', verify_notes: null });
  stmts.setSummary.run({ id: idPronta, title_pt: 'Título', summary_pt: 'Resumo' });
  stmts.upsertClassification.run({
    article_id: idPronta, result_json: '{}', domain_confidence: 1,
    taxonomy_version: 'v1', model_used: 'teste', status: 'done',
  });

  assert.deepEqual(urls(stmts.listArticlesToVerifyForRun.all(3, -1)), [pendente]);
  assert.deepEqual(urls(stmts.listArticlesNeedingSummaryForRun.all(3, -1)), [pendente]);
  assert.deepEqual(urls(stmts.listArticlesNeedingClassificationForRun.all(3, -1)), [pendente]);

  // e o global também não devolve a pronta (o filtro é o mesmo dos dois lados)
  assert.ok(!urls(stmts.listArticlesToVerify.all(-1)).includes(jaFeita));
  assert.ok(!urls(stmts.listArticlesNeedingSummary.all(-1)).includes(jaFeita));
  assert.ok(!urls(stmts.listArticlesNeedingClassification.all(-1)).includes(jaFeita));
  assert.ok(urls(stmts.listArticlesToVerify.all(-1)).includes(pendente));
});

// ---- dispatch das funções async: runId escopa; runId == null é o global do `finish` ----

test('*Pending({ runId }) de uma run SEM pendentes retorna cedo, sem LLM (dispatch escopado)', async () => {
  // Run 99 não existe: se as funções usassem o stmt GLOBAL (regressão do escopo), elas achariam
  // as fichas pendentes das runs 1..3 e seguiriam para a fase LLM — o retorno zerado prova que o
  // stmt escopado foi o escolhido.
  assert.deepEqual(await verifyPending({ runId: 99 }), { verified: 0, byVerdict: {} });
  assert.deepEqual(await summarizePending({ runId: 99 }), { summarized: 0, total: 0 });
  assert.deepEqual(await classifyPending({ runId: 99 }), { classified: 0, total: 0 });
});

test('os ids devolvidos pelo escopado são os da run (não um id qualquer da tabela)', () => {
  // id1/id2 são os únicos das runs 1/2 — a asserção por ID fecha o caso de a URL mentir.
  assert.deepEqual(ids(stmts.listArticlesToVerifyForRun.all(1, -1)), [id1]);
  assert.deepEqual(ids(stmts.listArticlesToVerifyForRun.all(2, -1)), [id2]);
  assert.deepEqual(ids(stmts.listArticlesNeedingSummaryForRun.all(1, -1)), [id1]);
  assert.deepEqual(ids(stmts.listArticlesNeedingClassificationForRun.all(2, -1)), [id2]);
});
