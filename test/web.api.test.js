// Testes do buscador web (`ncrawl web`). NC_HOME aponta p/ um diretório temporário ANTES dos
// imports dinâmicos (db.js resolve DB_PATH contra NC_HOME no load), então o schema nasce vazio;
// semeamos artigos/tags via stmts e exercitamos a API HTTP real em porta efêmera. Sem LLM/rede.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-web-test-'));
process.env.NC_HOME = NC_HOME_TMP;

const { stmts, db } = await import('../src/db.js');
const { startWebServer } = await import('../src/web.js');

// ---- seed ----
const alpha = stmts.upsertSource.get({ name: 'Fonte Alpha', base_url: 'http://alpha.test', type: 'listing', max_index_pages: null });
const beta = stmts.upsertSource.get({ name: 'Fonte Beta', base_url: 'http://beta.test', type: 'listing', max_index_pages: null });

function seedArticle({ source, url, title, content, published, titlePt, summaryPt, tags = [] }) {
  const r = stmts.insertArticle.run({
    source_id: source.id,
    url,
    title,
    content,
    content_hash: `hash-${url}`,
    published_at: published,
    run_id: null,
    // colunas do pipeline de curadoria/limpeza (defaults de artigo avulso já completo)
    kind: null,
    issue_url: null,
    section: null,
    blurb: null,
    content_source: 'target',
    cleaned: 0,
    needs_enrich: 0,
  });
  const id = Number(r.lastInsertRowid);
  if (titlePt || summaryPt) stmts.setSummary.run({ id, title_pt: titlePt || null, summary_pt: summaryPt || null });
  tags.forEach(({ facet, tag }, i) => stmts.insertTag.run({ article_id: id, facet, tag, rank: i + 1 }));
  return id;
}

const rsc = seedArticle({
  source: alpha,
  url: 'http://alpha.test/rsc',
  title: 'React Server Components deep dive',
  content: 'React Server Components change the rendering model for React apps.',
  published: '2026-06-20',
  titlePt: 'Mergulho em React Server Components',
  summaryPt: 'Como os RSC mudam o modelo de renderização.',
  tags: [
    { facet: 'domain', tag: 'reactjs' },
    { facet: 'content-type', tag: 'deep-dive' },
  ],
});
const epoca = seedArticle({
  source: alpha,
  url: 'http://alpha.test/epoca',
  title: 'Época nova para LLMs locais',
  content: 'Épocas novas para rodar LLMs locais com pouco hardware.',
  published: '2026-06-01',
  tags: [{ facet: 'domain', tag: 'local-llm' }],
});
const vitest = seedArticle({
  source: beta,
  url: 'http://beta.test/vitest',
  title: 'Vitest 3 released',
  content: 'The Vitest team shipped version 3 of the test runner.',
  published: '2026-06-25',
  tags: [{ facet: 'framework-library-tool', tag: 'vitest' }],
});
const semData = seedArticle({
  source: beta,
  url: 'http://beta.test/sem-data',
  title: 'Post sem data de publicação',
  content: 'Artigo sem published_at cai no extracted_at (hoje).',
  published: null,
});
// published_at CRU não-ISO (caso real do scrape): iso_date normaliza p/ ordenar/filtrar.
const verboso = seedArticle({
  source: alpha,
  url: 'http://alpha.test/verboso',
  title: 'Scraped date is not ISO',
  content: 'Some outlets publish dates like June 22, 2026 in prose.',
  published: 'June 22, 2026',
});
const verbosoIso = new Date('June 22, 2026').toISOString().slice(0, 10); // TZ-safe (mesma conta do iso_date)

const srv = await startWebServer({ port: 0, open: false });
const json = async (p) => {
  const r = await fetch(`http://127.0.0.1:${srv.port}${p}`);
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, ct, body: ct.includes('json') ? await r.json() : await r.text() };
};

after(async () => {
  await srv.close();
  db.close();
  rmSync(NC_HOME_TMP, { recursive: true, force: true });
});

// ---- API: listagem e ordenação ----
test('web: lista tudo ordenado por data desc (published_at com fallback extracted_at)', async () => {
  const { status, body } = await json('/api/articles');
  assert.equal(status, 200);
  assert.equal(body.total, 5);
  // sem-data usa extracted_at (agora) e vem primeiro; depois 06-25, ~06-22 (não-ISO), 06-20, 06-01
  assert.deepEqual(body.items.map((a) => a.id), [semData, vitest, verboso, rsc, epoca]);
  const first = body.items.find((a) => a.id === rsc);
  assert.equal(first.source_name, 'Fonte Alpha');
  assert.equal(first.title_pt, 'Mergulho em React Server Components');
  assert.deepEqual(first.tags.domain, ['reactjs']);
});

test('web: busca textual é case/acento-insensível (fold)', async () => {
  for (const q of ['épocas', 'EPOCAS', 'Épocas']) {
    const { body } = await json(`/api/articles?q=${encodeURIComponent(q)}`);
    assert.deepEqual(body.items.map((a) => a.id), [epoca], `q=${q}`);
  }
});

test('web: filtro por fonte', async () => {
  const { body } = await json(`/api/articles?source=${beta.id}`);
  assert.equal(body.total, 2);
  assert.ok(body.items.every((a) => a.source_name === 'Fonte Beta'));
});

test('web: facetas — OR dentro da faceta, AND entre facetas', async () => {
  const enc = (o) => encodeURIComponent(JSON.stringify(o));
  let r = await json(`/api/articles?facets=${enc({ domain: ['reactjs'] })}`);
  assert.deepEqual(r.body.items.map((a) => a.id), [rsc]);
  r = await json(`/api/articles?facets=${enc({ domain: ['reactjs', 'local-llm'] })}`);
  assert.equal(r.body.total, 2); // OR dentro da faceta
  r = await json(`/api/articles?facets=${enc({ domain: ['reactjs'], 'content-type': ['deep-dive'] })}`);
  assert.deepEqual(r.body.items.map((a) => a.id), [rsc]); // AND entre facetas
  r = await json(`/api/articles?facets=${enc({ domain: ['reactjs'], 'content-type': ['tutorial'] })}`);
  assert.equal(r.body.total, 0);
});

test('web: kind tool/news segue a semântica de isToolByTags', async () => {
  let r = await json('/api/articles?kind=tool');
  assert.deepEqual(r.body.items.map((a) => a.id), [vitest]);
  assert.equal(r.body.items[0].kind, 'tool');
  r = await json('/api/articles?kind=news');
  assert.equal(r.body.total, 4);
  assert.ok(r.body.items.every((a) => a.kind === 'news'));
});

test('web: período (from/to) sobre published_at com fallback', async () => {
  let r = await json('/api/articles?from=2026-06-21');
  assert.equal(r.body.total, 3); // vitest (06-25) + verboso (~06-22) + sem-data (hoje)
  r = await json('/api/articles?to=2026-06-05');
  assert.deepEqual(r.body.items.map((a) => a.id), [epoca]);
});

test('web: published_at não-ISO entra no filtro de período via iso_date', async () => {
  const { body } = await json(`/api/articles?from=${verbosoIso}&to=${verbosoIso}`);
  assert.deepEqual(body.items.map((a) => a.id), [verboso]);
});

test('web: paginação limit/offset mantém o total', async () => {
  const p1 = await json('/api/articles?limit=2');
  assert.equal(p1.body.total, 5);
  assert.equal(p1.body.items.length, 2);
  const p2 = await json('/api/articles?limit=2&offset=2');
  assert.equal(p2.body.items.length, 2);
  const ids = [...p1.body.items, ...p2.body.items].map((a) => a.id);
  assert.equal(new Set(ids).size, 4); // sem sobreposição
});

test('web: filtros combinados (q + fonte + kind)', async () => {
  const { body } = await json(`/api/articles?q=vitest&source=${beta.id}&kind=tool`);
  assert.deepEqual(body.items.map((a) => a.id), [vitest]);
});

// ---- API: validação ----
test('web: parâmetros inválidos viram 400 (não silenciosamente ignorados)', async () => {
  assert.equal((await json('/api/articles?facets=%7Bnot-json')).status, 400);
  assert.equal((await json('/api/articles?facets=%5B%22lista%22%5D')).status, 400); // array, não objeto
  assert.equal((await json('/api/articles?kind=banana')).status, 400);
  assert.equal((await json('/api/articles?source=abc')).status, 400);
  assert.equal((await json('/api/articles?from=not-a-date')).status, 400);
});

// ---- API: meta e artigo ----
test('web: /api/meta traz totais, fontes com contagem, facetas e faixa de datas', async () => {
  const { status, body } = await json('/api/meta');
  assert.equal(status, 200);
  assert.equal(body.totals.articles, 5);
  const alphaMeta = body.sources.find((s) => s.name === 'Fonte Alpha');
  assert.equal(alphaMeta.count, 3);
  const domain = body.facets.find((f) => f.name === 'domain');
  assert.ok(domain.tags.some((t) => t.tag === 'reactjs' && t.count === 1));
  assert.equal(body.dates.min, '2026-06-01');
});

test('web: /api/article/:id devolve artigo completo + tags; inexistente é 404', async () => {
  const { status, body } = await json(`/api/article/${rsc}`);
  assert.equal(status, 200);
  assert.ok(body.content.includes('rendering model'));
  assert.deepEqual(body.tags['content-type'], ['deep-dive']);
  assert.equal(body.kind, 'news');
  assert.equal((await json('/api/article/999999')).status, 404);
});

// ---- estáticos ----
test('web: serve a UI e os vendors locais (zero-build, sem CDN)', async () => {
  const home = await json('/');
  assert.equal(home.status, 200);
  assert.ok(String(home.body).includes('id="root"'));
  for (const p of ['/vendor/react.js', '/vendor/react-dom.js', '/vendor/htm.js', '/assets/app.js', '/assets/styles.css']) {
    assert.equal((await json(p)).status, 200, p);
  }
  assert.equal((await json('/vendor/../etc/passwd')).status, 404);
  assert.equal((await json('/nada')).status, 404);
});

test('web: método não-GET é 405', async () => {
  const r = await fetch(`http://127.0.0.1:${srv.port}/api/meta`, { method: 'POST' });
  assert.equal(r.status, 405);
});

// ---- kind curado (coluna) tem precedência sobre as tags; NULL cai no fallback por tags ----
test('web: coluna kind curada vence as tags no bucket tool/news', async (t) => {
  const mk = (url, kind, tags = []) => {
    const r = stmts.insertArticle.run({
      source_id: alpha.id, url, title: `k-${kind}`, content: `conteúdo ${url}`,
      content_hash: `hash-${url}`, published_at: '2026-06-30', run_id: null,
      kind, issue_url: 'http://agg.test/issue/1', section: null, blurb: 'blurb do agregador',
      content_source: 'aggregator', cleaned: 0, needs_enrich: 0,
    });
    const id = Number(r.lastInsertRowid);
    tags.forEach(({ facet, tag }, i) => stmts.insertTag.run({ article_id: id, facet, tag, rank: i + 1 }));
    return id;
  };
  const toolByCol = mk('http://agg.test/tool-sem-tags', 'tool');
  const relByCol = mk('http://agg.test/release-sem-tags', 'release');
  // rotulado news pela curadoria, mas com tag de ferramenta: a COLUNA decide (news)
  const newsByCol = mk('http://agg.test/news-com-tag-tool', 'news', [
    { facet: 'framework-library-tool', tag: 'vitest' },
  ]);
  t.after(() => {
    for (const id of [toolByCol, relByCol, newsByCol]) db.prepare('DELETE FROM articles WHERE id = ?').run(id);
  });
  const tool = await json('/api/articles?kind=tool');
  const toolIds = tool.body.items.map((a) => a.id);
  assert.ok(toolIds.includes(toolByCol) && toolIds.includes(relByCol), 'tool/release por coluna entram no bucket tool');
  assert.ok(!toolIds.includes(newsByCol), 'news por coluna fica fora mesmo com tag de ferramenta');
  const news = await json('/api/articles?kind=news');
  assert.ok(news.body.items.map((a) => a.id).includes(newsByCol));
  // snippet prioriza o blurb curado
  assert.ok(tool.body.items.find((a) => a.id === toolByCol).snippet.includes('blurb do agregador'));
});
