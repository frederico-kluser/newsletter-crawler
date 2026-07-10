// Testes da API pública JSON do acervo (`ncrawl export --format web` também gera
// webapp/public/api/v1/corpus.json). NC_HOME → tmp ANTES dos imports (db.js resolve DB_PATH no
// load), então o schema nasce vazio; semeamos via stmts e validamos o CONTRATO v1: envelope,
// campos camelCase, sourceName resolvido, byKind, verifyStatus, tags agrupadas, snippet
// (blurb > content, whitespace normalizado), tolerância a null, datas normalizadas, AUSÊNCIA do
// corpo completo e o DETERMINISMO (2 exports sem mudança na base = bytes idênticos fora generatedAt).
// Sem LLM/rede.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-export-api-test-'));
process.env.NC_HOME = NC_HOME_TMP;

const { stmts, db } = await import('../src/db.js');
const { buildPublicApi, exportPublicApi } = await import('../src/export-api.js');

// ---- seed (mesmo helper do export-web.test.js, + verifyStatus) ----
const alpha = stmts.upsertSource.get({ name: 'Fonte Alpha', base_url: 'http://alpha.test', type: 'index', max_index_pages: null });

function seedArticle({ url, title, content, published, kind = null, blurb = null, titlePt, summaryPt, tags = [], verify = null }) {
  const r = stmts.insertArticle.run({
    source_id: alpha.id,
    url,
    title,
    content,
    content_hash: `hash-${url}`,
    published_at: published,
    run_id: null,
    kind,
    issue_url: null,
    section: null,
    blurb,
    content_source: blurb ? 'aggregator' : 'target',
    cleaned: 0,
    needs_enrich: blurb ? 1 : 0,
  });
  const id = Number(r.lastInsertRowid);
  if (titlePt || summaryPt) stmts.setSummary.run({ id, title_pt: titlePt || null, summary_pt: summaryPt || null });
  if (verify) stmts.setVerify.run({ id, verify_status: verify, verify_notes: null });
  tags.forEach(({ facet, tag }, i) => stmts.insertTag.run({ article_id: id, facet, tag, rank: i + 1 }));
  return id;
}

// Completo: pt + tags em DUAS facetas fora da ordem alfabética (a canônica põe domain antes de
// content-type) + blurb (snippet prefere o blurb ao content) + verify ok + kind release.
const completo = seedArticle({
  url: 'http://alpha.test/completo',
  title: 'Vitest 3 released',
  content: 'Corpo   com\n\nespaços   e\nquebras para o snippet normalizar.',
  published: '2026-06-20',
  kind: 'release',
  blurb: 'Blurb  do\nagregador com whitespace.',
  titlePt: 'Vitest 3 lançado',
  summaryPt: 'O runner de testes chegou à v3.',
  verify: 'ok',
  tags: [
    { facet: 'content-type', tag: 'tool-release' },
    { facet: 'domain', tag: 'nodejs' },
  ],
});
// News + suspect, sem pt/tags parciais mas com kind news (entra no byKind.news).
const noticia = seedArticle({
  url: 'http://alpha.test/noticia',
  title: 'Something happened',
  content: 'Corpo da notícia.',
  published: '2026-06-18',
  kind: 'news',
  verify: 'suspect',
});
// Pendente (backlog): SEM title_pt/summary_pt/tags/kind; published_at CRU não-ISO (iso_date normaliza).
const pendente = seedArticle({
  url: 'http://alpha.test/pendente',
  title: 'Scraped date is not ISO',
  content: 'Some outlets publish dates like June 18, 2026 in prose.',
  published: 'June 18, 2026',
});
const pendenteIso = new Date('June 18, 2026').toISOString().slice(0, 10); // TZ-safe (conta do iso_date)

after(() => {
  db.close();
  rmSync(NC_HOME_TMP, { recursive: true, force: true });
});

test('api: envelope traz versão, totais, byKind, datas, fontes e facetas canônicas', () => {
  const c = buildPublicApi();
  assert.equal(c.schemaVersion, 1);
  assert.equal(c.documentation, '/api/v1/README.md');
  assert.equal(c.schema, '/api/v1/schema.json');
  assert.equal(c.totals.articles, 3);
  assert.equal(c.totals.summaries, 1);
  // `classified` conta a tabela `classifications` (resultado bruto), NÃO article_tags: o seed
  // popula só tags → 0. As tags POR artigo (de article_tags) são exercidas nos testes abaixo.
  assert.equal(c.totals.classified, 0);
  assert.deepEqual(c.totals.byKind, { news: 1, tool: 0, release: 1, unknown: 1 });
  assert.equal(c.dates.min, pendenteIso); // menor data (18/06) — 'June 18, 2026' normalizado
  assert.deepEqual(c.sources, [{ id: alpha.id, name: 'Fonte Alpha', count: 3 }]);
  // ordem canônica da taxonomia (domain antes de content-type), não a alfabética
  assert.deepEqual(c.facets.map((f) => f.name), ['domain', 'content-type']);
  assert.deepEqual(c.facets[0].tags, [{ tag: 'nodejs', count: 1 }]);
});

test('api: artigo completo tem contrato camelCase, sourceName, verifyStatus e tags agrupadas', () => {
  const { articles } = buildPublicApi();
  assert.deepEqual(articles.map((a) => a.id), [completo, noticia, pendente]); // id ASC

  const full = articles.find((a) => a.id === completo);
  assert.equal(full.url, 'http://alpha.test/completo');
  assert.equal(full.sourceId, alpha.id);
  assert.equal(full.sourceName, 'Fonte Alpha');
  assert.equal(full.title, 'Vitest 3 released');
  assert.equal(full.titlePt, 'Vitest 3 lançado');
  assert.equal(full.summaryPt, 'O runner de testes chegou à v3.');
  assert.equal(full.kind, 'release');
  assert.equal(full.date, '2026-06-20');
  assert.equal(full.verifyStatus, 'ok');
  assert.equal(full.snippet, 'Blurb do agregador com whitespace.'); // blurb > content, whitespace normalizado
  assert.deepEqual(full.tags, { 'content-type': ['tool-release'], domain: ['nodejs'] });
  assert.ok(!('content' in full), 'a API pública NÃO carrega o corpo completo');
});

test('api: campos pendentes vêm PRESENTES com null (nunca omitidos)', () => {
  const { articles } = buildPublicApi();
  const pend = articles.find((a) => a.id === pendente);
  assert.equal(pend.titlePt, null);
  assert.equal(pend.summaryPt, null);
  assert.equal(pend.kind, null);
  assert.equal(pend.section, null);
  assert.equal(pend.verifyStatus, null);
  assert.deepEqual(pend.tags, {}); // sem classificação → objeto vazio
  assert.equal(pend.date, pendenteIso); // "June 18, 2026" normalizado via iso_date

  const news = articles.find((a) => a.id === noticia);
  assert.equal(news.verifyStatus, 'suspect');
  assert.equal(news.kind, 'news');
});

test('api: export escreve corpus.json parseável e é determinístico (só generatedAt muda)', () => {
  const dir1 = path.join(NC_HOME_TMP, 'api1');
  const dir2 = path.join(NC_HOME_TMP, 'api2');
  const r1 = exportPublicApi({ outDir: dir1 });
  const r2 = exportPublicApi({ outDir: dir2 });
  assert.equal(r1.articles, 3);
  assert.equal(r2.articles, 3);

  const a = readFileSync(path.join(dir1, 'corpus.json'), 'utf8');
  const b = readFileSync(path.join(dir2, 'corpus.json'), 'utf8');
  const ca = JSON.parse(a);
  const cb = JSON.parse(b);
  assert.equal(ca.articles.length, ca.totals.articles); // articles.length == totals.articles
  delete ca.generatedAt;
  delete cb.generatedAt;
  assert.deepEqual(ca, cb, 'dois exports sem mudança na base só diferem no generatedAt');
});
