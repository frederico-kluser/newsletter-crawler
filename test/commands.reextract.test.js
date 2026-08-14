// `ncrawl reextract` (P5/P6 da captura 2026-08-14): RE-EXTRAI do zero artigos salvos —
// re-fetch (fetchSmartImpl injetado, ZERO rede) + re-parse + re-clean + UPDATE + re-verify.
// Sem chave LLM no ambiente: o caminho determinístico roda (re-extração + moldura + 2º passe
// do GitHub) e o clean/verify por IA é pulado — teste sem LLM, sem rede, sem fixtures externas
// além das páginas reais salvas em test/fixtures.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// NC_HOME temporário ANTES do import (config.js -> db.js). Chave LLM FORA do ambiente p/ o
// caminho ser 100% determinístico (sem clean/verify por IA).
process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-reextract-'));
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) delete process.env[k];
}
const { reextractTargets, REEXTRACT_DEFAULT_LIMIT } = await import('../src/reextract.js');
const { stmts, db } = await import('../src/db.js');
// O buffer de eventos só grava em lote (EVENTS_FLUSH_AT=50) — os testes consultam a tabela,
// então drenam o buffer explicitamente antes de ler.
const { flushEvents } = await import('../src/events.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readFixture = (name) => readFileSync(path.join(ROOT, 'test/fixtures', name), 'utf8');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

// Página com data machine-readable (article:published_time) + corpo > 400 chars — o caso
// avulso "data do alvo" do fluxo normal. O corpo é parametrizado por slug p/ dois alvos da
// mesma página não colidirem no UNIQUE(content_hash); a data é parametrizável (o teste do
// clamp usa uma data NO FUTURO).
const datedHtml = (slug, publishedAt = '2026-08-05T17:14:47.104Z') => `<!DOCTYPE html><html><head>
<meta property="article:published_time" content="${publishedAt}">
<title>Dated Post</title></head><body><article><h1>Dated Post</h1>
<p>Imagine you are building an e-commerce platform where every order must be reflected in both the primary database and the search index, and keeping them in sync by hand does not scale at all. This is the ${slug} instance of the same dated template.</p>
<p>This long-form article explains the problem in depth, shows the classic failure modes, and walks through the alternative patterns that real companies adopt in production today.</p>
<p>A final paragraph to keep the extracted text comfortably above the 400-char minimum that Readability requires before we consider it an article body.</p>
</article></body></html>`;

const FIXTURES = {
  vitest: readFixture('vitest-release.html'),
  meiert: readFixture('meiert-5-npx-helpers.html'),
};

const fakeFetch = async (url) => {
  if (url.includes('vitest-dev')) return { html: FIXTURES.vitest, url };
  if (url.includes('meiert.com')) return { html: FIXTURES.meiert, url };
  if (url.includes('dated.test') || url.includes('many.test')) {
    const slug = new URL(url).pathname.split('/').pop() || 'pagina';
    return { html: datedHtml(slug), url };
  }
  if (url.includes('mix.test')) {
    const slug = new URL(url).pathname.split('/').pop() || 'pagina';
    return { html: datedHtml(slug), url };
  }
  return { html: '<html><body><p>nenhum corpo real aqui.</p></body></html>', url };
};

// Página de ERRO com corpo GRANDE (o cenário do furo: 404 com >= 400 chars que o Readability
// extrai como "artigo" — título "404 Not Found" é o sinal p/ isErrorPage).
const errorPageHtml = `<!DOCTYPE html><html><head><title>404 Not Found</title></head><body><main>
<h1>404 Not Found</h1>
<p>This page could not be found. The link you followed may be broken, or the page may have been removed, or it may have never existed at all. Meanwhile you can browse the rest of the site: our best articles about distributed systems, event sourcing, database internals, and observability are listed in the sidebar for your convenience.</p>
<p>We have moved a lot of content around over the years, so it is entirely possible the page you are looking for now lives under a different path or inside the archive. The search box at the top of the page can locate it quickly if it still exists anywhere in this site.</p>
</main></body></html>`;

// Interstitial anti-bot (Cloudflare "Just a moment...") com corpo GRANDE — status 200, mas não
// é artigo; o título é o sinal p/ isBlockedPage.
const blockedPageHtml = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>
<h1>Just a moment...</h1>
<div class="cf-content"><p>Checking if the site connection is secure</p>
<p>Enable JavaScript and cookies to continue. This process is automatic and only takes a few seconds, and your browser will redirect to the requested content shortly once the verification completes successfully.</p>
<p>Please wait while we confirm that the request was legitimate and comes from a real browser, because we need to protect the site from automated access that could degrade the service for everyone else.</p>
<p>If you believe this is an error, contact the site owner or your network administrator, and include the Ray ID shown below together with the time of the request so they can investigate.</p>
</div></body></html>`;

// Fetch que devolve data NO FUTURO (post agendado/fuso) no alvo.
const futureFetch = async (url) => {
  const slug = new URL(url).pathname.split('/').pop() || 'pagina';
  return { html: datedHtml(slug, '2099-01-01T00:00:00.000Z'), url };
};

const insertRow = (row) =>
  stmts.insertArticle.run({
    source_id: row.sourceId ?? null,
    url: row.url,
    title: row.title,
    content: row.content ?? 'conteúdo antigo e poluído',
    content_hash: row.content_hash ?? `hash-${row.url}`,
    published_at: row.published_at ?? null,
    run_id: 1,
    kind: row.kind ?? 'release',
    issue_url: row.issue_url ?? null,
    section: null,
    blurb: row.blurb ?? 'blurb do agregador',
    content_source: row.content_source ?? 'target',
    cleaned: 0,
    needs_enrich: 0,
  });

test('reextract: re-extrai a release do GitHub sem o botão de UI e com quebras de bloco', async () => {
  const src = stmts.upsertSource.get({ name: 'VitestFeed', base_url: 'https://github.com', type: 'listing', max_index_pages: null });
  const url = 'https://github.com/vitest-dev/vitest/releases/tag/v5.0.0-rc.1';
  insertRow({ url, title: 'Vitest 5.0 Release Candidate', sourceId: src.id });
  const before = stmts.getArticleFullByUrl.get(url);

  const out = await reextractTargets({ fetchSmartImpl: fakeFetch, urlFilter: 'vitest-dev' });
  assert.equal(out.reextracted, 1, 'uma ficha re-extraída');
  assert.equal(out.skipped, 0);

  const row = stmts.getArticleFullByUrl.get(url);
  assert.ok(row.content.startsWith('🚨 Breaking Changes'), 'corpo da release re-extraído');
  assert.ok(row.content.includes('browser: Serve framework assets as immutable'), 'lista de PRs completa');
  assert.ok(!/view changes on github/i.test(row.content), 'botão de UI removido');
  assert.ok(row.content.length > before.content.length, 'corpo re-extraído mais rico (quebras de bloco)');
  assert.notEqual(row.content_hash, before.content_hash, 'hash re-calculado');
  assert.equal(row.verify_status, null, 'sem LLM: verify não roda (coluna intacta)');
  assert.equal(row.cleaned, 0, 'sem LLM: clean não roda');
  assert.equal(row.content_source, 'target');
  assert.equal(row.needs_enrich, 0, 'não volta p/ a fila de enrich');
});

test('reextract: remove a moldura do meiert.com quando o clean não roda (sem LLM)', async () => {
  const src = stmts.upsertSource.get({ name: 'MeiertFeed', base_url: 'https://meiert.com', type: 'listing', max_index_pages: null });
  const url = 'https://meiert.com/blog/5-npx-helpers';
  insertRow({ url, title: '5 Useful npx Helpers', sourceId: src.id });

  const out = await reextractTargets({ fetchSmartImpl: fakeFetch, urlFilter: 'meiert' });
  assert.equal(out.reextracted, 1);

  const row = stmts.getArticleFullByUrl.get(url);
  assert.ok(row.content.startsWith('npx allows you to run Node.js packages right away.'), 'byline removida');
  assert.ok(!/here on meiert\.com/i.test(row.content), 'rodapé/bio removido');
  // baseline honesta: o texto cru do Readability da MESMA página (com a moldura) tem 3434 chars
  assert.ok(row.content.length < 3434, 'sem a moldura, o corpo é mais curto que a extração crua');
  assert.notEqual(row.content_hash, 'hash-' + url);
});

test('reextract: published_at só muda p/ item AVULSO; item de issue mantém a âncora (P1)', async () => {
  const src = stmts.upsertSource.get({ name: 'DatedFeed', base_url: 'https://dated.test', type: 'listing', max_index_pages: null });
  const issueUrl = 'https://dated.test/issues/637';
  // avulso (sem issue_url): a data do ALVO (08-05) pode virar published_at
  insertRow({ url: 'https://dated.test/avulso', title: 'Avulso', published_at: '2026-08-13', sourceId: src.id });
  // item de ISSUE: a âncora é a data da issue — a do alvo NUNCA sobrescreve
  insertRow({
    url: 'https://dated.test/item-da-issue', title: 'Item da issue', published_at: '2026-08-13',
    issue_url: issueUrl, sourceId: src.id,
  });

  const out = await reextractTargets({ fetchSmartImpl: fakeFetch, urlFilter: 'dated.test' });
  assert.equal(out.reextracted, 2);

  const avulso = stmts.getArticleFullByUrl.get('https://dated.test/avulso');
  assert.equal(avulso.published_at, '2026-08-05T17:14:47.104Z', 'avulso adota a data nova do alvo');
  const daIssue = stmts.getArticleFullByUrl.get('https://dated.test/item-da-issue');
  assert.equal(daIssue.published_at, '2026-08-13', 'item de issue mantém a âncora da issue');
});

test('reextract: blurb-only (sem corpo do alvo) fica de fora; filtro por URL restringe', async () => {
  const src = stmts.upsertSource.get({ name: 'MixFeed', base_url: 'https://mix.test', type: 'listing', max_index_pages: null });
  // content_source='aggregator' (blurb-only): não tem o que re-extrair
  insertRow({
    url: 'https://mix.test/blurb-only', title: 'Blurb Only',
    content: 'titulo — blurb do agregador', content_source: 'aggregator', sourceId: src.id,
  });
  insertRow({
    url: 'https://mix.test/target-a', title: 'Target A', content_source: 'target', sourceId: src.id,
  });
  insertRow({
    url: 'https://mix.test/target-b', title: 'Target B', content_source: 'target', sourceId: src.id,
  });

  const out = await reextractTargets({ fetchSmartImpl: fakeFetch, urlFilter: 'target-a' });
  assert.equal(out.reextracted, 1, 'só o filtrado');
  const a = stmts.getArticleFullByUrl.get('https://mix.test/target-a');
  assert.notEqual(a.content_hash, 'hash-https://mix.test/target-a', 'target-a re-extraído');
  const b = stmts.getArticleFullByUrl.get('https://mix.test/target-b');
  assert.equal(b.content_hash, 'hash-https://mix.test/target-b', 'target-b intacto');
  const blurb = stmts.getArticleFullByUrl.get('https://mix.test/blurb-only');
  assert.equal(blurb.content_hash, 'hash-https://mix.test/blurb-only', 'blurb-only nunca tocado');
});

test('reextract: sem conteúdo extraível a ficha antiga é mantida (fail-open)', async () => {
  const src = stmts.upsertSource.get({ name: 'ThinFeed', base_url: 'https://thin.test', type: 'listing', max_index_pages: null });
  const url = 'https://thin.test/quase-vazio';
  insertRow({ url, title: 'Quase vazio', sourceId: src.id });
  const out = await reextractTargets({ fetchSmartImpl: fakeFetch, urlFilter: 'thin.test' });
  const row = stmts.getArticleFullByUrl.get(url);
  assert.equal(row.content, 'conteúdo antigo e poluído', 'ficha antiga mantida');
  assert.equal(out.reextracted, 0);
  assert.equal(out.skipped, 1, 'thin contada como pulada (no-content)');
});

test('reextract: página de ERRO (404 com corpo grande) NÃO sobrescreve a ficha boa (isErrorPage)', async () => {
  const src = stmts.upsertSource.get({ name: 'ErrFeed', base_url: 'https://err.test', type: 'listing', max_index_pages: null });
  const url = 'https://err.test/sumiu';
  insertRow({ url, title: 'Post que sumiu', sourceId: src.id });
  const fakeError = async (u) => ({ html: errorPageHtml, url: u });

  const out = await reextractTargets({ fetchSmartImpl: fakeError, urlFilter: 'err.test' });
  assert.equal(out.reextracted, 0, 'nada re-extraído');
  assert.equal(out.skipped, 1, 'pulada pelo guard');
  const row = stmts.getArticleFullByUrl.get(url);
  assert.equal(row.content, 'conteúdo antigo e poluído', 'corpo bom NÃO trocado por 404');
  assert.equal(row.content_hash, `hash-${url}`, 'hash intacto (não houve UPDATE)');
  flushEvents(); // o buffer de eventos é em lote — drena antes de ler a tabela
  const ev = stmts.listEventsForUrl.all(`%${url}%`, 10).find((e) => e.stage === 'reextract');
  assert.ok(ev, 'evento de reextract registrado');
  assert.match(ev.detail, /"reason":"error-page"/, 'o guard que pegou foi o isErrorPage');
});

test('reextract: página BLOQUEADA (interstitial) NÃO sobrescreve item curado (isBlockedPage)', async () => {
  const src = stmts.upsertSource.get({ name: 'BlockedFeed', base_url: 'https://blocked.test', type: 'listing', max_index_pages: null });
  const url = 'https://blocked.test/desafio';
  // item de ISSUE (curado): a regra de keepAggregatorVersion do crawl vale aqui — alvo ruim
  // NUNCA substitui a versão atual (o registro nem volta p/ enrich: não é needs_enrich).
  insertRow({
    url, title: 'Item curado da issue', issue_url: 'https://blocked.test/issues/1',
    published_at: '2026-08-13', sourceId: src.id,
  });
  const fakeBlocked = async (u) => ({ html: blockedPageHtml, url: u });

  const out = await reextractTargets({ fetchSmartImpl: fakeBlocked, urlFilter: 'blocked.test' });
  assert.equal(out.reextracted, 0);
  assert.equal(out.skipped, 1);
  const row = stmts.getArticleFullByUrl.get(url);
  assert.equal(row.content, 'conteúdo antigo e poluído', 'ficha atual mantida');
  assert.equal(row.published_at, '2026-08-13', 'âncora da issue intacta');
  flushEvents(); // o buffer de eventos é em lote — drena antes de ler a tabela
  const ev = stmts.listEventsForUrl.all(`%${url}%`, 10).find((e) => e.stage === 'reextract');
  assert.ok(ev, 'evento de reextract registrado');
  assert.equal(ev.status, 'kept-blurb', 'item curado: status espelha o kept-blurb do crawl');
  assert.match(ev.detail, /"reason":"blocked-page"/, 'o guard que pegou foi o isBlockedPage');
});

test('reextract: sem --limit, no máx. REEXTRACT_DEFAULT_LIMIT fichas; --all varre tudo', async () => {
  const src = stmts.upsertSource.get({ name: 'ManyFeed', base_url: 'https://many.test', type: 'listing', max_index_pages: null });
  const N = 25;
  for (let i = 0; i < N; i++) {
    insertRow({ url: `https://many.test/artigo-${i}`, title: `Artigo ${i}`, sourceId: src.id });
  }
  // sem limit: default PEQUENO (o CLI passa isso quando não há --limit nem --all)
  const outDefault = await reextractTargets({ fetchSmartImpl: fakeFetch, urlFilter: 'many.test' });
  assert.equal(outDefault.reextracted + outDefault.skipped, REEXTRACT_DEFAULT_LIMIT, 'default pequeno respeitado');
  // limit Infinity (o que --all emite): varredura completa
  const outAll = await reextractTargets({ fetchSmartImpl: fakeFetch, urlFilter: 'many.test', limit: Infinity });
  assert.equal(outAll.reextracted + outAll.skipped, N, '--all cobre o acervo todo');
});

test('reextract: published_at FUTURO de avulso é clampado (clampFutureDate); issue mantém a âncora', async () => {
  const src = stmts.upsertSource.get({ name: 'FutureFeed', base_url: 'https://futuro.test', type: 'listing', max_index_pages: null });
  // avulso: a data do alvo (2099!) é o que seria gravado — o clamp a trava em HOJE. Slug
  // ÚNICO (o conteúdo duplicado do teste P1 colidiria no UNIQUE(content_hash) -> dup-hash).
  insertRow({ url: 'https://futuro.test/futuro-avulso', title: 'Avulso futuro', published_at: '2026-08-13', sourceId: src.id });
  // item de ISSUE: a âncora da curadoria vale — data futura do alvo NUNCA entra (P1)
  insertRow({
    url: 'https://futuro.test/futuro-da-issue', title: 'Item da issue futuro',
    published_at: '2026-08-13', issue_url: 'https://futuro.test/issues/1', sourceId: src.id,
  });

  const out = await reextractTargets({ fetchSmartImpl: futureFetch, urlFilter: 'futuro.test' });
  assert.equal(out.reextracted, 2, 'ambos re-extraídos (corpo ok; só a data muda)');
  const avulso = stmts.getArticleFullByUrl.get('https://futuro.test/futuro-avulso');
  assert.equal(avulso.published_at, new Date().toISOString().slice(0, 10), 'data futura clampada p/ hoje');
  const daIssue = stmts.getArticleFullByUrl.get('https://futuro.test/futuro-da-issue');
  assert.equal(daIssue.published_at, '2026-08-13', 'item de issue mantém a âncora (P1)');
});
