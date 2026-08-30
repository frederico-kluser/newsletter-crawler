// Testes do snapshot estático do webapp (`ncrawl export --format web`). NC_HOME aponta p/ um
// diretório temporário ANTES dos imports dinâmicos (db.js resolve DB_PATH contra NC_HOME no
// load), então o schema nasce vazio; semeamos via stmts e validamos os shapes, a tolerância a
// nulls (backlog sem resumo/tags), a normalização de datas (iso_date + fallback extracted_at),
// a PARTIÇÃO do contents (meta.contentsParts, união íntegra, partes <= alvo, sem contents.json
// no outDir) e o DETERMINISMO (2 exports sem mudança na base = bytes idênticos fora o
// generatedAt do meta). Sem LLM/rede.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-export-web-test-'));
process.env.NC_HOME = NC_HOME_TMP;

const { stmts, db } = await import('../src/db.js');
const { buildWebSnapshot, exportWebSnapshot } = await import('../src/export-web.js');
// config importado para o teste provider-aware de meta.search.models (mesma instância do ESM).
const config = await import('../src/config.js');

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
  // O export espelha o modelo RESOLVIDO do runtime (stageModel já traduz; fallback via
  // translateModel) — não o slug cru do config/models.json. No provider default (openrouter)
  // translateModel é identidade, então vale o slug OpenRouter de hoje.
  assert.equal(meta.search.models.searchBatch.model, config.stageModel('searchBatch').model);
  assert.equal(meta.search.models.searchRelevance.model, config.stageModel('searchRelevance').model);
  assert.equal(meta.search.models.searchSpec.model, config.stageModel('searchSpec').model);
  assert.equal(meta.search.models.fallback.model, config.translateModel(config.MODELS.pro));
  // sem llm_usage semeado não há amostra: costHints omitido por completo (cliente usa seeds)
  assert.deepEqual(meta.search.costHints, {});
  assert.equal(meta.dates.min, pendenteIso);
});

test('export web: meta.search.models reflete o provider ATIVO (deepseek direto = slug traduzido)', () => {
  // Troca o provider em runtime (setRuntimeKey, mesmo padrão do llm.provider.test.js) e volta no
  // finally — o snapshot precisa refletir o que o runtime usa de fato, nunca o slug OpenRouter cru.
  const prevProvider = config.LLM_PROVIDER;
  const prevKey = config.LLM_PROVIDER === 'deepseek' ? config.DEEPSEEK_API_KEY : config.OPENROUTER_API_KEY;
  try {
    config.setRuntimeKey('sk-ds-teste', 'deepseek');
    const { meta } = buildWebSnapshot();
    // Slugs diretos da API da DeepSeek (deepseek-v4-flash | deepseek-v4-pro); forma preservada.
    assert.equal(meta.search.models.searchBatch.model, 'deepseek-v4-flash');
    assert.equal(meta.search.models.searchRelevance.model, 'deepseek-v4-flash');
    assert.equal(meta.search.models.searchSpec.model, 'deepseek-v4-flash');
    assert.equal(meta.search.models.fallback.model, 'deepseek-v4-flash');
    assert.equal(meta.search.models.searchBatch.effort, 'medium', 'effort preservado');
  } finally {
    config.setRuntimeKey(prevKey, prevProvider);
  }
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
  assert.ok(!('content' in full), 'articles.json não carrega o corpo (contents.partN.json é lazy)');
});

test('export web: base pequena => 1 parte; meta.contentsParts espelha as partes; união == id→content íntegro', () => {
  const { meta, contentsParts } = buildWebSnapshot();
  // Default (EXPORT_WEB_PART_MB = 85 MB) com 3 artigos minúsculos => UMA parte cobrindo todos os ids.
  const min = Math.min(completo, pendente, semData);
  const max = Math.max(completo, pendente, semData);
  assert.deepEqual(
    meta.contentsParts,
    [{ file: 'contents.part0.json', from: min, to: max }],
    'o meta expõe [file, from, to] de cada parte p/ o cliente localizar sem baixar tudo',
  );
  assert.equal(contentsParts.length, 1);
  assert.deepEqual(
    contentsParts.map(({ file, from, to }) => ({ file, from, to })),
    meta.contentsParts,
  );
  // A união das partes == o map id→content que o contents.json único carregava (nada se perde).
  const union = {};
  for (const p of contentsParts) Object.assign(union, p.map);
  assert.deepEqual(Object.keys(union).map(Number), [completo, pendente, semData]); // id ASC
  assert.ok(union[completo].includes('quebras'));
  assert.equal(union[semData], '');
});

test('export web: multipartes — sem contents.json no outDir e NENHUMA parte passa do alvo de bytes', () => {
  // Alvo minúsculo p/ forçar várias partes com uma base pequena (0.0001 MB ≈ 104 bytes).
  const partMb = 0.0001;
  const targetBytes = Math.floor(partMb * 1024 * 1024);
  const dir = path.join(NC_HOME_TMP, 'out-parts');
  mkdirSync(dir, { recursive: true });
  // Resíduo do export antigo (o arquivo único de 80-100 MB) e uma parte velha: o export novo
  // TEM de remover o contents.json — nunca pode sobrar p/ o hook/deploy o commitarem de novo.
  writeFileSync(path.join(dir, 'contents.json'), '{"999": "velho"}');
  writeFileSync(path.join(dir, 'contents.part9.json'), '{"9": "velho"}');
  const r = exportWebSnapshot({ outDir: dir, partMb });

  assert.ok(!existsSync(path.join(dir, 'contents.json')), 'contents.json removido do outDir');
  assert.ok(r.parts.length >= 2, `várias partes esperadas com alvo minúsculo (${r.parts.length})`);
  assert.deepEqual(r.parts, JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')).contentsParts);

  // Cada parte: existe, fica DENTRO do alvo (o corte por estimativa nunca subestima o byte final)
  // e carrega um map id→content íntegro; a união == o contents esperado, sem id repetido.
  const expected = {
    [completo]: 'Corpo   com\n\nespaços   e\nquebras para o snippet normalizar.',
    [pendente]: 'Some outlets publish dates like June 18, 2026 in prose.',
    [semData]: '',
  };
  const seen = new Map();
  for (const p of r.parts) {
    const raw = readFileSync(path.join(dir, p.file), 'utf8');
    assert.ok(Buffer.byteLength(raw) <= targetBytes, `${p.file} <= alvo de ${targetBytes} bytes`);
    const map = JSON.parse(raw);
    // ids estritamente crescentes em cada parte (partição determinística em ordem de id)
    const ids = Object.keys(map).map(Number);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    for (const id of ids) {
      assert.ok(!seen.has(id), `id ${id} não se repete entre partes`);
      seen.set(id, map[id]);
      assert.equal(map[id], expected[id], `conteúdo do id ${id} íntegro na parte`);
    }
  }
  assert.deepEqual(Object.keys(expected).map(Number).sort((a, b) => a - b), [...seen.keys()].sort((a, b) => a - b));
});

test('export web: determinístico — 2 exports diferem só no generatedAt do meta', () => {
  const dir1 = path.join(NC_HOME_TMP, 'out1');
  const dir2 = path.join(NC_HOME_TMP, 'out2');
  const r1 = exportWebSnapshot({ outDir: dir1 });
  const r2 = exportWebSnapshot({ outDir: dir2 });
  assert.equal(r1.articles, 3);
  assert.equal(r2.articles, 3);
  assert.deepEqual(r1.parts, r2.parts, 'mesma base => mesmas partes (mesmos arquivos/from/to)');
  const names = ['articles.json', ...r1.parts.map((p) => p.file)];
  for (const name of names) {
    const a = readFileSync(path.join(dir1, name), 'utf8');
    const b = readFileSync(path.join(dir2, name), 'utf8');
    assert.equal(a, b, `${name} deve ser byte-idêntico entre exports sem mudança na base`);
    JSON.parse(a); // e parsear
  }
  assert.ok(!existsSync(path.join(dir1, 'contents.json')), 'o export nunca deixa contents.json no outDir');
  const m1 = JSON.parse(readFileSync(path.join(dir1, 'meta.json'), 'utf8'));
  const m2 = JSON.parse(readFileSync(path.join(dir2, 'meta.json'), 'utf8'));
  delete m1.generatedAt;
  delete m2.generatedAt;
  assert.deepEqual(m1, m2, 'meta idêntico fora o generatedAt (contentsParts inclusive)');
});
