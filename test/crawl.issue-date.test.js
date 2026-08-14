// FIX P1 (captura 2026-08-14, Node Weekly): 13/15 artigos ficaram com published_at errado
// (a data do ALVO, 08-05, espalhada pelo fallback sibling) porque a data da issue era
// descartada no enqueue da listagem e a página da issue não tem data machine-readable.
// O fix tem 3 camadas:
//   1. herança AUTORITATIVA listagem -> roundup -> itens (frontier.discovered_date),
//   2. rede p/ issues sem meta (extractPublishedDate por TEXTO visível),
//   3. endurecimento no enrich (a data do alvo NUNCA vira data de item de issue).
// Aqui: as partes puras (enqueue/roundupIssueDate/enrichAnchorDate) + o wire end-to-end
// (processRoundup/processArticle reais com fetch/LLM mockados, sem rede).
// NC_HOME temporário ANTES do import (crawl.js -> db.js abre o banco no load).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-issue-date-'));
const { enqueue, roundupIssueDate, enrichAnchorDate } = await import('../src/crawl.js');
const { stmts, db } = await import('../src/db.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

// ---- (a) enqueue herda a data do par da LISTAGEM p/ a frontier ----
test('enqueue: grava discovered_date na frontier (6º parâmetro); NULL quando ausente', () => {
  const src = stmts.upsertSource.get({
    name: 'DataWeekly', base_url: 'https://dataweekly.test', type: 'index', max_index_pages: null,
  });
  const listing = 'https://dataweekly.test/issues';
  const issue = 'https://dataweekly.test/issues/42';
  assert.equal(enqueue(issue, 'roundup', listing, src.id, 1, '2026-08-13'), true);
  const row = stmts.claimNextCurate.get();
  assert.equal(row.kind, 'roundup');
  assert.equal(row.discovered_date, '2026-08-13', 'a data do par da listagem vira discovered_date');
  assert.equal(row.discovered_from, listing);
  // Sem data (default dos chamadores antigos) -> coluna NULL, contrato preservado.
  const plain = 'https://dataweekly.test/issues/41';
  assert.equal(enqueue(plain, 'roundup', listing, src.id, 1), true);
  const row2 = stmts.claimNextCurate.get();
  assert.equal(row2.discovered_date, null);
});

// ---- (b) resolução da data da issue: listagem autoritativa, página como fallback ----
test('roundupIssueDate: discovered_date da listagem é autoritativa; sem ela cai p/ a página', () => {
  const r = roundupIssueDate({ discovered_date: '2026-08-13' }, 'August 1, 2026');
  assert.equal(r.raw, '2026-08-13', 'a data da listagem vence a da página');
  assert.equal(r.parsed.toISOString().slice(0, 10), '2026-08-13');
  const r2 = roundupIssueDate({ discovered_date: null }, 'August 13, 2026');
  assert.equal(r2.raw, 'August 13, 2026', 'fallback: texto visível da página da issue');
  assert.equal(r2.parsed.toISOString().slice(0, 10), '2026-08-13');
  const r3 = roundupIssueDate({ discovered_date: 'lixo' }, '2026-08-01');
  assert.equal(r3.raw, '2026-08-01', 'data da listagem inparseável ignora e usa a da página');
  assert.deepEqual(roundupIssueDate({ discovered_date: null }, null), { raw: null, parsed: null });
});

// ---- (c) endurecimento: a data do ALVO nunca vira a data de item de issue ----
test('enrichAnchorDate: item de ISSUE NUNCA recebe a data do alvo; avulso mantém a própria', () => {
  const item = { issue_url: 'https://dataweekly.test/issues/42', published_at: '2026-08-13' };
  assert.equal(enrichAnchorDate(item, '2026-08-05'), '2026-08-13', 'âncora da issue vence o alvo');
  assert.equal(
    enrichAnchorDate({ ...item, published_at: null }, '2026-08-05'),
    null,
    'sem data da issue: NULL, nunca a data do alvo',
  );
  assert.equal(enrichAnchorDate({ issue_url: null, published_at: null }, '2026-08-05'), '2026-08-05');
  assert.equal(enrichAnchorDate({ issue_url: null, published_at: '2026-08-13' }, '2026-08-05'), '2026-08-13');
  assert.equal(enrichAnchorDate(null, '2026-08-05'), '2026-08-05');
});

// ---- (d) + (e): wire end-to-end (processRoundup/processArticle reais, fetch/LLM mockados) ----
const WIRE_CHILD_SOURCE = `import { mock } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import OpenAI from 'openai';

const root = process.argv[2]; // raiz da worktree (passada pelo teste pai)
const ncHome = mkdtempSync(path.join(tmpdir(), 'nc-issue-date-wire-'));
process.env.NC_HOME = ncHome;
process.on('exit', () => rmSync(ncHome, { recursive: true, force: true }));
// Env limpo: nada do shell pode vazar p/ a resolução de modelos (mesmo padrão do llm.provider).
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) delete process.env[k];
}
process.env.OPENROUTER_API_KEY = 'sk-or-teste'; // HAS_LLM on p/ a curadoria rodar

// Transporte FAKE no SDK (mesmo padrão do llm.provider-client.test.js): o llm.js REAL (callJSON
// + zod) roda por cima; só o HTTP vira uma resposta canônica por schema. ZERO rede.
const Completions = OpenAI.Chat.Completions;
mock.method(Completions.prototype, 'create', async function createMock(body) {
  const name = body?.response_format?.json_schema?.name;
  const content = name === 'curated_items'
    ? JSON.stringify(itemFor(curSuffix))
    : name === 'clean_article'
      ? JSON.stringify({ title: null, junk_spans: [], published_at: null })
      : null;
  if (content === null) throw new Error('schema inesperado no wire test: ' + name);
  return { model: 'deepseek-v4-flash', usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [{ message: { content } }] };
});
// fetchSmart FAKE por URL: alvo (ex.org) devolve a página COM data meta (caso freecodecamp);
// issue devolve a página SEM meta (caso nodeweekly). mock.module SÓ do fetch.js — no grafo do
// filho ele é importado APENAS por crawl.js (fetchSmart+checkRobots), então a substituição é
// completa; o llm.js fica REAL (vai pelo transporte fake do SDK acima).
mock.module(pathToFileURL(path.join(root, 'src/fetch.js')).href, {
  namedExports: {
    fetchSmart: async (url) => ({
      html: String(url).startsWith('https://ex.org/') ? TARGET_HTML : FIXTURE,
      url,
    }),
    checkRobots: async () => ({ allowed: true }),
  },
});

// Página da issue SEM meta/time/JSON-LD — a data aparece SÓ no texto visível (o caso nodeweekly).
const FIXTURE = \`<html><head><title>Data Weekly #42</title></head><body>
<article>
<h1>Data Weekly #42</h1>
<p>Issue published on August 13, 2026.</p>
<p>This is a fake newsletter issue body with enough prose to pass the curatable threshold and exercise the pipeline without any network call at all.</p>
<p>Second paragraph keeps the body comfortably above the 200-char minimum so extraction succeeds deterministically.</p>
</article></body></html>\`;
// Página do ALVO com data machine-readable (meta article:published_time — o caso freecodecamp
// da captura real, que virou a âncora errada p/ 12 artigos da issue).
const TARGET_HTML = \`<html><head>
<meta property="article:published_time" content="2026-08-05T17:14:47.104Z">
<title>Dual-write Post</title></head>
<body><article><h1>Fixing the Dual-Write Problem</h1>
<p>Imagine you are building an e-commerce platform where every order must be reflected in both the primary database and the search index, and keeping them in sync by hand does not scale at all.</p>
<p>This long-form article explains the dual-write problem in depth, shows the classic failure modes, and walks through the alternative patterns that real companies adopt in production today.</p>
<p>A final paragraph to keep the extracted text comfortably above the 400-char minimum that Readability requires before we consider it an article body.</p>
</article></body></html>\`;

let curSuffix = 'a';
const itemFor = (suffix) => ({
  issue_date: null, // sem data visível p/ o curador: a âncora vem da cadeia (listagem/texto)
  items: [{
    url: 'https://ex.org/item-' + suffix, title: 'Post ' + suffix,
    kind: 'news', section: null, blurb: 'blurb do agregador ' + suffix,
  }],
});
// Logs do crawler vão p/ o console (stdout) — silencia p/ o stdout carregar SÓ o JSON final.
const { setLogSink } = await import(pathToFileURL(path.join(root, 'src/util.js')).href);
setLogSink(() => {});
const { stmts, db } = await import(pathToFileURL(path.join(root, 'src/db.js')).href);
const { enqueue, processJob } = await import(pathToFileURL(path.join(root, 'src/crawl.js')).href);

const src = stmts.upsertSource.get({
  name: 'DataWeekly', base_url: 'https://dataweekly.test', type: 'index', max_index_pages: null,
});
const listing = 'https://dataweekly.test/issues';
const publishedByIssue = (url) =>
  stmts.listArticlesBySource.all(src.id).filter((r) => r.issue_url === url).map((r) => r.published_at);

const out = {};
try {
  // (d) caso A: job de roundup com discovered_date da listagem -> item herda a data da issue.
  {
    const issueUrl = 'https://dataweekly.test/issues/42-a';
    curSuffix = 'a';
    enqueue(issueUrl, 'roundup', listing, src.id, 1, '2026-08-13');
    await processJob(stmts.claimNextCurate.get(), { runId: 1, sinceDate: null, aggressive: true });
    out.a = publishedByIssue(issueUrl);
  }
  // (d) caso B: issue com discovered_date ANTERIOR ao piso --since é ignorada ANTES da
  // curadoria (a data da página 08-13 não pisoaria; só a da listagem 08-01 pisa).
  {
    const issueUrl = 'https://dataweekly.test/issues/42-b';
    curSuffix = 'b';
    enqueue(issueUrl, 'roundup', listing, src.id, 1, '2026-08-01');
    await processJob(stmts.claimNextCurate.get(), {
      runId: 1, sinceDate: new Date('2026-08-11'), aggressive: true,
    });
    out.b = publishedByIssue(issueUrl);
  }
  // (d) caso C: SEM discovered_date, a data do TEXTO visível da página ancora a issue (rede).
  {
    const issueUrl = 'https://dataweekly.test/issues/42-c';
    curSuffix = 'c';
    enqueue(issueUrl, 'roundup', listing, src.id, 1, null);
    await processJob(stmts.claimNextCurate.get(), { runId: 1, sinceDate: null, aggressive: true });
    out.c = publishedByIssue(issueUrl);
  }
  // (e) enrich de item curado: a data do ALVO (meta 08-05) NUNCA sobrescreve a data da issue.
  {
    const issueUrl = 'https://dataweekly.test/issues/42-e';
    const itemUrl = 'https://ex.org/item-e';
    stmts.insertArticle.run({
      source_id: src.id, url: itemUrl, title: 'Dual-write fix', content: 'Dual-write fix — blurb',
      content_hash: 'hash-item-e', published_at: '2026-08-13', run_id: 1, kind: 'news',
      issue_url: issueUrl, section: null, blurb: 'blurb', content_source: 'aggregator',
      cleaned: 0, needs_enrich: 1,
    });
    await processJob({ url: itemUrl, kind: 'article', depth: 2, discovered_from: issueUrl, source_id: src.id }, {
      runId: 1, sinceDate: null, aggressive: true,
    });
    const row = stmts.getArticleFullByUrl.get(itemUrl);
    out.e = { published: row.published_at, content_source: row.content_source, needs_enrich: row.needs_enrich };
  }
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  process.stderr.write(String((e && e.stack) || e));
  process.exitCode = 1;
} finally {
  db.close();
}
`;

test('wire: roundup com discovered_date -> item herda a data da issue; piso usa a data da listagem; texto visível é a rede; enrich NUNCA pega a data do alvo', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // Script num tmp com symlink p/ o node_modules da worktree: o `import 'openai'` do filho
  // resolve para a MESMA instância de módulo que o llm.js usa (a identidade do prototype mock).
  const wireDir = mkdtempSync(path.join(os.tmpdir(), 'nc-issue-date-wire-dir-'));
  try {
    symlinkSync(path.join(root, 'node_modules'), path.join(wireDir, 'node_modules'), 'dir');
    const scriptPath = path.join(wireDir, 'wire-issue-date.mjs');
    writeFileSync(scriptPath, WIRE_CHILD_SOURCE, 'utf8');
    const child = spawnSync(
      process.execPath,
      ['--experimental-test-module-mocks', scriptPath, root],
      { encoding: 'utf8', timeout: 60000 },
    );
    assert.equal(child.status, 0, `filho do wire test falhou: ${child.stderr || child.stdout || child.error}`);
    assert.ok(child.stdout.trim(), 'filho sem stdout');
    const out = JSON.parse(child.stdout);
    assert.deepEqual(out.a, ['2026-08-13'], 'data da LISTAGEM vira published_at do item curado');
    assert.deepEqual(out.b, [], 'issue anterior ao piso --since ignorada ANTES da curadoria (data da listagem)');
    assert.deepEqual(out.c, ['August 13, 2026'], 'sem data da listagem: TEXTO visível da página ancora a issue');
    assert.equal(out.e.published, '2026-08-13', 'enrich preserva a data da issue, nunca a do alvo');
    assert.equal(out.e.content_source, 'target', 'o corpo do alvo ainda enriquece o item');
    assert.equal(out.e.needs_enrich, 0);
  } finally {
    rmSync(wireDir, { recursive: true, force: true });
  }
});
