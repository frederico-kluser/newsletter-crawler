// Camada de dados do RESTORE (repovoar o SQLite a partir do snapshot versionado em git, a base
// de registro depois de um `reset` acidental). O que precisa valer: idempotência (rodar duas
// vezes não duplica nem estoura constraint), dedup compatível com o crawler (content_hash BIT-A-
// BIT igual ao sha256 do crawl.js/curate.js), NUNCA rebaixar trabalho vivo (um restore por cima
// de uma base em uso não pode cancelar fila nem queimar tentativa de enriquecimento), NUNCA
// abortar no meio (FK de source_id) e marcar território conhecido para o `isUrlKnown` casar.
// O que este arquivo NÃO afirma: que sem o restore o crawler re-caminharia o arquivo inteiro
// (`crawlArchive` já para com `added === 0`), nem que hoje as ISSUES viram território conhecido
// — o snapshot exportado não carrega `issue_url` (ver o teste no fim, que fixa a lacuna).
// NC_HOME em tmpdir ANTES de importar db (padrão do repo) — o banco real do usuário nunca é aberto.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-db-restore-'));
const {
  db, stmts, restoreArticle, restoreSourceByName, restoreTags, markUrlDone, restorePage,
  countArticles, restoreCounts,
} = await import('../src/db.js');
const { sha256, normalizeUrl } = await import('../src/util.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

const known = (url) => Boolean(stmts.isUrlKnown.get(url, url, url, url));

// ---- fontes: remapeamento do source_id do snapshot ----

test('restoreSourceByName: cria por nome, reencontra por nome e por base_url', () => {
  const a = restoreSourceByName('JS Weekly', 'https://javascriptweekly.com/issues', 'index');
  assert.equal(a.created, true);
  assert.equal(a.source.base_url, 'https://javascriptweekly.com/issues');
  assert.equal(a.source.type, 'index');

  const b = restoreSourceByName('JS Weekly'); // o snapshot só carrega o NOME
  assert.equal(b.id, a.id);
  assert.equal(b.created, false);

  const c = restoreSourceByName('Outro Nome', 'https://javascriptweekly.com/issues');
  assert.equal(c.id, a.id, 'base_url tem precedência e NÃO renomeia a fonte viva');
  assert.equal(stmts.getSourceById.get(a.id).name, 'JS Weekly');
});

test('restoreSourceByName: sem base_url cria rótulo e COMPLETA o base_url depois (sem sobrescrever)', () => {
  const a = restoreSourceByName('Só Nome');
  assert.equal(a.created, true);
  assert.equal(a.source.base_url, null);
  const b = restoreSourceByName('Só Nome', 'https://so-nome.example');
  assert.equal(b.id, a.id);
  assert.equal(b.source.base_url, 'https://so-nome.example');
  // já preenchido: uma segunda base_url não sobrescreve
  restoreSourceByName('Só Nome', 'https://outra.example');
  assert.equal(stmts.getSourceById.get(a.id).base_url, 'https://so-nome.example');
});

// ---- artigos ----

// Fonte local usada pelos testes de artigo (o chamador do restore remapeia o id do snapshot p/
// este ANTES de chamar restoreArticle; um id não remapeado é RECUSADO com reason 'bad-source').
const FONTE = restoreSourceByName('Fonte do Snapshot', 'https://fonte-snap.example');

const SNAP = {
  id: 4242, // id do SNAPSHOT: nunca é usado como id local
  source_id: 999, // idem — todo teste abaixo sobrescreve com FONTE.id
  url: 'https://alvo.example/post?utm_source=news',
  title: 'Node-GTK 4.0',
  title_pt: 'Node-GTK 4.0',
  summary_pt: 'Resumo em PT-BR.',
  snippet: 'Node-GTK 4.0 — bindings...',
  date_iso: '2026-03-04',
  kind: 'release',
  section: 'Releases',
  verify_status: 'ok',
  verify_notes: null,
};
const CONTENT = 'Corpo completo do artigo restaurado.';

test('restoreArticle: insere o artigo completo com a semântica do restore', () => {
  const src = FONTE;
  const r = restoreArticle({ ...SNAP, source_id: src.id, content: CONTENT });
  assert.equal(r.inserted, true);
  const row = stmts.getArticleFullByUrl.get(normalizeUrl(SNAP.url));
  assert.equal(row.id, r.id);
  assert.equal(row.source_id, src.id, 'source_id é o LOCAL, não o do snapshot');
  assert.equal(row.url, 'https://alvo.example/post', 'URL normalizada (utm_ removido), como no crawler');
  assert.equal(row.title, SNAP.title);
  assert.equal(row.title_pt, SNAP.title_pt);
  assert.equal(row.summary_pt, SNAP.summary_pt);
  assert.equal(row.published_at, '2026-03-04', 'date_iso -> published_at');
  assert.equal(row.kind, 'release');
  assert.equal(row.section, 'Releases');
  assert.equal(row.verify_status, 'ok');
  assert.equal(row.content, CONTENT);
  assert.equal(row.content_source, 'restore');
  assert.equal(row.needs_enrich, 0, 'o corpo já veio: não re-enfileira p/ enriquecer');
  assert.equal(row.cleaned, 1);
  assert.equal(row.enrich_attempts, 0);
});

// F2: se o hash divergisse do que o crawler calcula, a dedup por conteúdo falharia e o próximo
// crawl salvaria o MESMO artigo de novo. Os dois lados usam sha256() de util.js sobre o content.
test('restoreArticle: content_hash é o MESMO sha256(content) que o crawler grava', () => {
  const row = stmts.getArticleFullByUrl.get('https://alvo.example/post');
  assert.equal(row.content_hash, sha256(CONTENT));
  // e o stmt de dedup do crawler (getArticleByHash) encontra a linha restaurada
  assert.equal(stmts.getArticleByHash.get(sha256(CONTENT)).id, row.id);
});

// F3: idempotência.
test('restoreArticle rodado 2x sobre o mesmo snapshot não duplica nem estoura constraint', () => {
  const antes = countArticles();
  const r = restoreArticle({ ...SNAP, source_id: FONTE.id, content: CONTENT });
  assert.equal(r.inserted, false);
  assert.equal(r.reason, 'url');
  assert.equal(r.id, stmts.getArticleByUrl.get('https://alvo.example/post').id);
  assert.equal(countArticles(), antes, 'nenhuma linha nova');
});

test('restoreArticle: URL diferente com conteúdo idêntico é ignorada por hash (como no crawler)', () => {
  const antes = countArticles();
  const r = restoreArticle({
    ...SNAP, source_id: FONTE.id, url: 'https://espelho.example/post', content: CONTENT,
  });
  assert.equal(r.inserted, false);
  assert.equal(r.reason, 'hash');
  assert.equal(countArticles(), antes);
});

test('restoreArticle: conteúdo VAZIO grava hash NULL (sha256("") colidiria no índice UNIQUE)', () => {
  const a = restoreArticle({ url: 'https://vazio.example/1', title: 'A', content: '' });
  const b = restoreArticle({ url: 'https://vazio.example/2', title: 'B' }); // sem campo content
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, true, 'dois artigos sem corpo convivem');
  assert.equal(stmts.getArticleFullByUrl.get('https://vazio.example/1').content_hash, null);
  assert.equal(stmts.getArticleFullByUrl.get('https://vazio.example/2').content, '');
});

test('restoreArticle: sem URL não grava nada', () => {
  const antes = countArticles();
  assert.deepEqual(restoreArticle({ title: 'sem url' }), { inserted: false, id: null, reason: 'no-url' });
  assert.equal(countArticles(), antes);
});

// FK: `OR IGNORE` NÃO cobre violação de foreign key em SQLite — sem a pré-checagem, um único
// source_id ruim lançava SQLITE_CONSTRAINT_FOREIGNKEY e derrubava o restore de 4581 artigos no
// meio, deixando a base pela metade. Contrato: pular a linha e reportar, nunca lançar.
test('restoreArticle: source_id INEXISTENTE pula a linha e reporta (não lança FK)', () => {
  const antes = countArticles();
  const idFantasma = (db.prepare('SELECT max(id) m FROM sources').get().m ?? 0) + 999;
  let out;
  assert.doesNotThrow(() => {
    out = restoreArticle({ source_id: idFantasma, url: 'https://fk.example/1', title: 'T', content: 'corpo fk' });
  });
  assert.deepEqual(out, { inserted: false, id: null, reason: 'bad-source' });
  assert.equal(countArticles(), antes, 'nada foi gravado');
  // determinístico: mesma entrada, mesmo veredito
  assert.deepEqual(
    restoreArticle({ source_id: idFantasma, url: 'https://fk.example/1', title: 'T', content: 'corpo fk' }),
    { inserted: false, id: null, reason: 'bad-source' },
  );
  // e o restore SEGUE: a linha seguinte, com fonte válida, entra normalmente
  const src = restoreSourceByName('Fonte FK', 'https://fk-ok.example');
  assert.equal(
    restoreArticle({ source_id: src.id, url: 'https://fk.example/2', title: 'T', content: 'corpo fk 2' }).inserted,
    true,
  );
});

test('restoreArticle: source_id NULL é legal (a FK aceita NULL) e insere', () => {
  const a = restoreArticle({ source_id: null, url: 'https://fk.example/nulo', title: 'T', content: 'corpo nulo' });
  assert.equal(a.inserted, true);
  assert.equal(stmts.getArticleFullByUrl.get('https://fk.example/nulo').source_id, null);
  // campo AUSENTE tem o mesmo tratamento de null
  assert.equal(
    restoreArticle({ url: 'https://fk.example/ausente', title: 'T', content: 'corpo ausente' }).inserted,
    true,
  );
});

test('restorePage: source_id inexistente é pulado (não lança FK); null insere', () => {
  const idFantasma = (db.prepare('SELECT max(id) m FROM sources').get().m ?? 0) + 999;
  let out;
  assert.doesNotThrow(() => { out = restorePage('https://fk.example/issue-ruim', idFantasma); });
  assert.equal(out, false);
  assert.equal(db.prepare('SELECT * FROM pages WHERE url = ?').get('https://fk.example/issue-ruim'), undefined);
  assert.equal(restorePage('https://fk.example/issue-nula', null), true);
  assert.equal(db.prepare('SELECT source_id FROM pages WHERE url = ?').get('https://fk.example/issue-nula').source_id, null);
});

// ---- tags / classificação ----

test('restoreTags: grava article_tags com rank e é idempotente', () => {
  const id = stmts.getArticleByUrl.get('https://alvo.example/post').id;
  const tags = { domain: ['web-development', 'devtools'], 'content-type': ['version-release'] };
  const first = restoreTags(id, tags);
  assert.equal(first.tags, 3);
  const rows = stmts.getTagsForArticle.all(id);
  assert.deepEqual(
    rows.map((r) => `${r.facet}/${r.tag}/${r.rank}`).sort(),
    ['content-type/version-release/0', 'domain/devtools/1', 'domain/web-development/0'],
  );
  const second = restoreTags(id, tags);
  assert.equal(second.tags, 0, 'INSERT OR IGNORE: 2ª passada não escreve nada');
  assert.equal(stmts.getTagsForArticle.all(id).length, 3);
});

test('restoreTags: por padrão NÃO inventa linha em classifications (o snapshot não tem os campos)', () => {
  const id = stmts.getArticleByUrl.get('https://alvo.example/post').id;
  assert.equal(stmts.getClassification.get(id), undefined);
  // consequência assumida: o artigo segue elegível ao sweep de classificação
  const pendentes = stmts.listArticlesNeedingClassification.all(-1).map((a) => a.id);
  assert.ok(pendentes.includes(id));
});

test('restoreTags markClassified: grava rótulo EXPLÍCITO "restored" e nunca rebaixa uma real', () => {
  const r = restoreArticle({ url: 'https://marc.example/1', title: 'M', content: 'corpo marc' });
  const out = restoreTags(r.id, { domain: ['ai'] }, { markClassified: true });
  assert.equal(out.classification, true);
  const c = stmts.getClassification.get(r.id);
  assert.equal(c.status, 'restored');
  assert.equal(c.model_used, 'restore');
  assert.deepEqual(JSON.parse(c.result_json).facets, { domain: ['ai'] });
  // sai da fila do sweep
  assert.ok(!stmts.listArticlesNeedingClassification.all(-1).some((a) => a.id === r.id));

  // classificação REAL já existente não é sobrescrita
  stmts.upsertClassification.run({
    article_id: r.id, result_json: '{"facets":{"domain":["ai"]}}', domain_confidence: 0.9,
    taxonomy_version: 'v1', model_used: 'flash', status: 'done',
  });
  const out2 = restoreTags(r.id, { domain: ['ai'] }, { markClassified: true });
  assert.equal(out2.classification, false);
  assert.equal(stmts.getClassification.get(r.id).status, 'done');
});

test('restoreTags: entrada inválida é fail-open', () => {
  assert.deepEqual(restoreTags(null, { a: ['b'] }), { tags: 0, classification: false });
  assert.deepEqual(restoreTags(1, null), { tags: 0, classification: false });
  const r = restoreArticle({ url: 'https://inval.example/1', title: 'I', content: 'corpo inval' });
  assert.equal(restoreTags(r.id, { domain: 'nao-e-array', outra: ['', null, 'ok'] }).tags, 1);
});

// ---- território conhecido: frontier + pages ----

test('markUrlDone: cria a linha na frontier, marca done e torna a URL conhecida', () => {
  const url = 'https://alvo.example/post';
  assert.equal(known(url), true); // já conhecido por articles
  const out = markUrlDone(url, 'article', 1);
  assert.equal(out.created, true);
  assert.equal(out.marked, true);
  assert.equal(db.prepare('SELECT state FROM frontier WHERE url = ?').get(url).state, 'done');
  const again = markUrlDone(url, 'article', 1);
  assert.deepEqual(again, { url, created: false, marked: false }, 'idempotente');
});

test('markUrlDone: normaliza a URL e converte failed -> done (job abandonado)', () => {
  stmts.enqueue.run('https://fila.example/falhou', 'article', null, 1, 0, null);
  db.prepare("UPDATE frontier SET state = 'failed' WHERE url = ?").run('https://fila.example/falhou');
  const out = markUrlDone('https://fila.example/falhou?utm_medium=x');
  assert.deepEqual(out, { url: 'https://fila.example/falhou', created: false, marked: true });
  assert.equal(
    db.prepare('SELECT state FROM frontier WHERE url = ?').get('https://fila.example/falhou').state,
    'done',
  );
});

test('markUrlDone NÃO rebaixa trabalho vivo: in_progress e pending ficam intactos', () => {
  for (const [nome, estado] of [['voando', 'in_progress'], ['nafila', 'pending']]) {
    const url = `https://fila.example/${nome}`;
    stmts.enqueue.run(url, 'article', null, 1, 0, null);
    db.prepare('UPDATE frontier SET state = ? WHERE url = ?').run(estado, url);
    const out = markUrlDone(url);
    assert.deepEqual(out, { url, created: false, marked: false }, `${estado} não devia ser marcado`);
    assert.equal(
      db.prepare('SELECT state FROM frontier WHERE url = ?').get(url).state,
      estado,
      'job vivo (na fila ou reivindicado por outro processo) não é roubado',
    );
  }
});

// REPRO do bug: restore por cima de uma base VIVA. O artigo já existe (restoreArticle devolve
// reason 'url', não repõe nada) e o job de enriquecimento dele ainda está na fila. Marcar essa
// URL como 'done' cancelaria o enriquecimento pendente E cobraria uma tentativa fantasma: 'done'
// + needs_enrich=1 é contado como RODADA FALHADA por bumpFailedEnrichAttempts, então o job que
// NUNCA rodou perderia uma das ENRICH_MAX_ATTEMPTS.
test('markUrlDone sobre base viva: preserva o job pending e NÃO queima enrich_attempts', () => {
  const src = restoreSourceByName('Base Viva', 'https://viva.example');
  const url = 'https://viva.example/alvo';
  stmts.insertArticle.run({
    source_id: src.id, url, title: 'T', content: 'blurb do agregador', content_hash: 'h-viva',
    published_at: null, run_id: 1, kind: 'news', issue_url: null, section: null,
    blurb: 'blurb do agregador', content_source: 'aggregator', cleaned: 0, needs_enrich: 1,
  });
  stmts.enqueue.run(url, 'article', null, src.id, 0, null);
  const estado = () => db.prepare('SELECT state FROM frontier WHERE url = ?').get(url).state;
  const tentativas = () => stmts.getArticleFullByUrl.get(url).enrich_attempts;
  assert.equal(estado(), 'pending');
  assert.equal(tentativas(), 0);

  const rest = restoreArticle({ source_id: src.id, url, title: 'T', content: 'corpo do snapshot' });
  assert.equal(rest.inserted, false);
  assert.equal(rest.reason, 'url', 'o artigo vivo não é reposto (URL já existe)');
  assert.deepEqual(markUrlDone(url, 'article', src.id), { url, created: false, marked: false });
  assert.equal(estado(), 'pending', 'o job continua na fila para ser enriquecido');
  assert.equal(stmts.getArticleFullByUrl.get(url).needs_enrich, 1);

  // e a rodada seguinte do crawl não contabiliza tentativa nenhuma para esse alvo
  stmts.bumpFailedEnrichAttempts.run(src.id);
  assert.equal(tentativas(), 0, 'nenhuma tentativa fantasma: o job nunca rodou');
});

test('restorePage: registra a issue/listagem e NÃO sobrescreve uma página já visitada', () => {
  assert.equal(restorePage('https://fonte-snap.example/issues/700', 1), true);
  assert.equal(known('https://fonte-snap.example/issues/700'), true);
  assert.equal(restorePage('https://fonte-snap.example/issues/700', 1), false, 'idempotente');

  stmts.upsertPage.run({
    source_id: 1, url: 'https://fonte-snap.example/issues/701', html_hash: 'HASH-REAL',
    status: 'done', pagination_depth: 3,
  });
  restorePage('https://fonte-snap.example/issues/701', 1);
  const p = db.prepare('SELECT * FROM pages WHERE url = ?').get('https://fonte-snap.example/issues/701');
  assert.equal(p.html_hash, 'HASH-REAL');
  assert.equal(p.pagination_depth, 3);
});

// ---- contagens do relatório ----

test('restoreCounts/countArticles reportam o estado do acervo', () => {
  const c = restoreCounts();
  assert.equal(c.articles, countArticles());
  assert.ok(c.articles > 0 && c.sources > 0 && c.pages > 0 && c.tags > 0);
  assert.equal(c.frontier.total, db.prepare('SELECT COUNT(*) c FROM frontier').get().c);
  assert.ok(c.frontier.done >= 2);
});

// ---- fim a fim: o que o snapshot de HOJE consegue (e o que não consegue) reconstruir ----

// Uma linha com EXATAMENTE as colunas que `webExportArticles` (src/db.js) e src/export-api.js
// emitem hoje. Note a AUSÊNCIA de issue_url — medido no snapshot commitado:
// `grep -c "javascriptweekly.com/issues" webapp/public/data/articles.json` -> 0.
const snapRow = (i) => ({
  id: 100 + i,
  source_id: null, // remapeado pelo chamador; aqui o teste injeta o id local
  url: `https://fim.example/a${i}`,
  title: `T${i}`,
  title_pt: `T${i} PT`,
  summary_pt: 'resumo',
  snippet: 'trecho...',
  date_iso: `2026-04-0${i}`,
  kind: 'news',
  section: 'News',
  verify_status: 'ok',
  verify_notes: null,
});

test('snapshot COMO É EXPORTADO HOJE: os ARTIGOS viram território conhecido, a ISSUE não', () => {
  const src = restoreSourceByName('Fim a Fim', 'https://fim.example');
  const issue = 'https://fim.example/issues/1'; // existe no mundo real, NÃO no snapshot
  const links = [1, 2, 3].map((i) => ({ ...snapRow(i), source_id: src.id, content: `corpo distinto ${i}` }));

  for (const row of links) {
    assert.equal(Object.hasOwn(row, 'issue_url'), false, 'o export não emite issue_url');
    assert.equal(restoreArticle(row).inserted, true);
    markUrlDone(row.url, 'article', src.id);
  }

  // ganho REAL de hoje: os alvos já restaurados casam no isUrlKnown (1º e 3º ramos).
  assert.equal(links.filter((r) => known(r.url)).length, links.length);
  // LACUNA declarada: sem issue_url no snapshot, o chamador não tem o que passar p/ restorePage
  // e o 4º ramo (articles.issue_url) não casa — a issue segue "nova" e pode ser re-curada.
  assert.equal(known(issue), false, 'a issue NÃO é território conhecido com o export atual');
  assert.equal(db.prepare('SELECT 1 FROM pages WHERE url = ?').get(issue), undefined);
});

// Contrato para a onda do EXPORT: assim que o snapshot passar a carregar `issue_url`, estes dois
// ramos fecham a lacuna acima SEM mudança nenhuma no db.js. O teste exercita o mecanismo com o
// campo presente — e está aqui declaradamente como especificação do que falta no export, não
// como afirmação de que o snapshot de hoje já o traz (o teste acima fixa o contrário).
test('COM issue_url no snapshot: restorePage e o 4º ramo do isUrlKnown tornam a issue conhecida', () => {
  const src = restoreSourceByName('Com Issue', 'https://comissue.example');
  const issue = 'https://comissue.example/issues/700';
  assert.equal(known(issue), false);

  // (a) 4º ramo: basta o artigo curado carregar o issue_url de origem
  assert.equal(
    restoreArticle({
      ...snapRow(9), source_id: src.id, url: 'https://comissue.example/item',
      issue_url: issue, content: 'corpo do item curado',
    }).inserted,
    true,
  );
  assert.equal(stmts.getArticleFullByUrl.get('https://comissue.example/item').issue_url, issue);
  assert.equal(known(issue), true, 'articles.issue_url casa no 4º ramo');

  // (b) 2º ramo: a mesma URL registrada em `pages` (idempotente e sem sobrescrever visita real)
  const outra = 'https://comissue.example/issues/701';
  assert.equal(known(outra), false);
  assert.equal(restorePage(outra, src.id), true);
  assert.equal(known(outra), true, 'pages casa no 2º ramo');
});
