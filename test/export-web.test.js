// Testes do snapshot estático do webapp (`ncrawl export --format web`). NC_HOME aponta p/ um
// diretório temporário ANTES dos imports dinâmicos (db.js resolve DB_PATH contra NC_HOME no
// load), então o schema nasce vazio; semeamos via stmts e validamos os shapes, a tolerância a
// nulls (backlog sem resumo/tags), a normalização de datas (iso_date + fallback extracted_at)
// e o DETERMINISMO (2 exports sem mudança na base = bytes idênticos fora o generatedAt do meta).
// Sem LLM/rede.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-export-web-test-'));
process.env.NC_HOME = NC_HOME_TMP;

const { stmts, db } = await import('../src/db.js');
const { buildWebSnapshot, exportWebSnapshot } = await import('../src/export-web.js');

// ---- seed (mesmo helper do web.api.test.js) ----
const alpha = stmts.upsertSource.get({ name: 'Fonte Alpha', base_url: 'http://alpha.test', type: 'index', max_index_pages: null });

function seedArticle({ url, title, content, published, kind = null, blurb = null, titlePt, summaryPt, tags = [] }) {
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
  tags.forEach(({ facet, tag }, i) => stmts.insertTag.run({ article_id: id, facet, tag, rank: i + 1 }));
  return id;
}

// Completo: pt + tags em DUAS facetas fora da ordem canônica (content-type < domain no alfabeto,
// mas a canônica põe domain primeiro) + blurb (o snippet deve preferir o blurb ao content).
const completo = seedArticle({
  url: 'http://alpha.test/completo',
  title: 'Vitest 3 released',
  content: 'Corpo   com\n\nespaços   e\nquebras para o snippet normalizar.',
  published: '2026-06-20',
  kind: 'release',
  blurb: 'Blurb  do\nagregador com whitespace.',
  titlePt: 'Vitest 3 lançado',
  summaryPt: 'O runner de testes chegou à v3.',
  tags: [
    { facet: 'content-type', tag: 'tool-release' },
    { facet: 'domain', tag: 'nodejs' },
  ],
});
// Pendente (backlog): SEM title_pt/summary_pt/tags; published_at CRU não-ISO (iso_date normaliza).
const pendente = seedArticle({
  url: 'http://alpha.test/pendente',
  title: 'Scraped date is not ISO',
  content: 'Some outlets publish dates like June 18, 2026 in prose.',
  published: 'June 18, 2026',
});
const pendenteIso = new Date('June 18, 2026').toISOString().slice(0, 10); // TZ-safe (conta do iso_date)
// Sem published_at (cai em date(extracted_at) = hoje) e sem content (contents deve trazer '').
const semData = seedArticle({
  url: 'http://alpha.test/sem-data',
  title: 'Post sem data',
  content: null,
  published: null,
});

after(() => {
  db.close();
  rmSync(NC_HOME_TMP, { recursive: true, force: true });
});

test('export web: meta traz totais, fontes, facetas em ordem canônica e config da busca', () => {
  const { meta } = buildWebSnapshot();
  assert.equal(meta.schemaVersion, 1);
  assert.equal(meta.totals.articles, 3);
  assert.equal(meta.totals.summaries, 1);
  assert.deepEqual(meta.sources, [{ id: alpha.id, name: 'Fonte Alpha', count: 3 }]);
  // ordem canônica da taxonomia (domain antes de content-type), não a alfabética do GROUP BY
  assert.deepEqual(meta.facets.map((f) => f.name), ['domain', 'content-type']);
  assert.deepEqual(meta.facets[0].tags, [{ tag: 'nodejs', count: 1 }]);
  assert.ok(meta.toolContentTypes.includes('tooling'));
  assert.equal(meta.search.batchSize, 40);
  assert.equal(meta.search.deepConfirm, 200);
  assert.ok(meta.search.models.searchBatch.model.includes('flash'));
  assert.ok(meta.search.models.fallback.model.includes('pro'));
  // sem llm_usage semeado não há amostra: costHints omitido por completo (cliente usa seeds)
  assert.deepEqual(meta.search.costHints, {});
  assert.equal(meta.dates.min, pendenteIso);
});

test('export web: articles tolera nulls, normaliza datas e prefere blurb no snippet', () => {
  const { articles } = buildWebSnapshot();
  assert.deepEqual(articles.map((a) => a.id), [completo, pendente, semData]); // id ASC

  const full = articles.find((a) => a.id === completo);
  assert.equal(full.kind, 'release');
  assert.equal(full.title_pt, 'Vitest 3 lançado');
  assert.equal(full.date_iso, '2026-06-20');
  assert.equal(full.snippet, 'Blurb do agregador com whitespace.'); // blurb > content, whitespace normalizado
  assert.deepEqual(full.tags, { 'content-type': ['tool-release'], domain: ['nodejs'] });

  const pend = articles.find((a) => a.id === pendente);
  assert.equal(pend.title_pt, null); // campo PRESENTE com null, nunca omitido
  assert.equal(pend.summary_pt, null);
  assert.deepEqual(pend.tags, {}); // sem classificação → objeto vazio
  assert.equal(pend.date_iso, pendenteIso); // "June 18, 2026" normalizado via iso_date

  const sem = articles.find((a) => a.id === semData);
  assert.equal(sem.date_iso, new Date().toISOString().slice(0, 10)); // fallback extracted_at (hoje)
  assert.equal(sem.snippet, '');
  assert.ok(!('content' in full), 'articles.json não carrega o corpo (contents.json é lazy)');
});

test('export web: contents mapeia id→content com string vazia p/ content nulo', () => {
  const { contents } = buildWebSnapshot();
  assert.deepEqual(Object.keys(contents).map(Number), [completo, pendente, semData]);
  assert.ok(contents[completo].includes('quebras'));
  assert.equal(contents[semData], '');
});

test('export web: determinístico — 2 exports diferem só no generatedAt do meta', () => {
  const dir1 = path.join(NC_HOME_TMP, 'out1');
  const dir2 = path.join(NC_HOME_TMP, 'out2');
  const r1 = exportWebSnapshot({ outDir: dir1 });
  const r2 = exportWebSnapshot({ outDir: dir2 });
  assert.equal(r1.articles, 3);
  assert.equal(r2.articles, 3);
  for (const name of ['articles.json', 'contents.json']) {
    const a = readFileSync(path.join(dir1, name), 'utf8');
    const b = readFileSync(path.join(dir2, name), 'utf8');
    assert.equal(a, b, `${name} deve ser byte-idêntico entre exports sem mudança na base`);
    JSON.parse(a); // e parsear
  }
  const m1 = JSON.parse(readFileSync(path.join(dir1, 'meta.json'), 'utf8'));
  const m2 = JSON.parse(readFileSync(path.join(dir2, 'meta.json'), 'utf8'));
  delete m1.generatedAt;
  delete m2.generatedAt;
  assert.deepEqual(m1, m2);
});
