// FIX Achado 3 (captura 2026-08-14): "react-dropzone 20.0" (react-dropzone.js.org) salvou JSON
// CRU como conteúdo — Readability/content-selector falharam e o fallback LLM ecoou o blob
// estruturado do site como "corpo". O fix tem 2 camadas:
//   1. looksLikeJson (parse-core): detecção PURA de JSON objeto/array (fail-open),
//   2. guarda em processArticle: corpo que looksLikeJson -> item curado mantém o blurb do
//      agregador (keepAggregatorVersion 'json-page'); avulso é descartado com evento skip.
// Aqui: as partes puras (looksLikeJson) + o wire end-to-end (processArticle real com
// fetch/LLM mockados, sem rede — mesmo padrão do crawl.issue-date.test.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-json-page-'));
const { looksLikeJson } = await import('../src/parse-core.js');
const { db } = await import('../src/db.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

// ---- (a) looksLikeJson: puro, fail-open ----
test('looksLikeJson: objeto/array -> true; HTML/prosa/JSON parcial/literais -> false', () => {
  // JSON de verdade: objeto e array (com espaço em branco ao redor)
  assert.equal(looksLikeJson('{"title": "Simple HTML5 drag \'n\' drop zone", "version": "20.0.0"}'), true);
  assert.equal(looksLikeJson('["a", "b", {"c": 1}]'), true);
  assert.equal(looksLikeJson('  \n\t{"a":1}\n  '), true, 'leading/trailing whitespace não atrapalha');
  assert.equal(looksLikeJson('{"nested": {"deep": [1, 2, {"x": null}]}}'), true);
  // Disjunto de looksLikeHtml: markup não é JSON
  assert.equal(looksLikeJson('<p>{"a":1}</p>'), false, 'HTML real não é JSON');
  assert.equal(looksLikeJson('<article>{"title":"x"}</article>'), false, 'JSON embrulhado em HTML não é JSON');
  // Prosa com "<" solto (mesmo caso do ensurePlainText) não é JSON
  assert.equal(looksLikeJson('a < b && b > c — Array<T> é genérico'), false);
  assert.equal(looksLikeJson('A {"curly": "quote"} dentro de prosa'), false, 'JSON citado dentro de prosa não é JSON puro');
  // JSON parcial/truncado (o que o LLM ecoou cortado): fail-open -> false
  assert.equal(looksLikeJson('{"title": "Simple HTML5 drag'), false, 'JSON truncado passa (fail-open)');
  // Literais/outros tipos não são objeto/array
  assert.equal(looksLikeJson('null'), false, 'literal null não conta');
  assert.equal(looksLikeJson('42'), false);
  assert.equal(looksLikeJson('"string"'), false);
  assert.equal(looksLikeJson(''), false);
  assert.equal(looksLikeJson(null), false);
  assert.equal(looksLikeJson(undefined), false);
  assert.equal(looksLikeJson('{"a": 1} lixo depois'), false, 'sobra após o objeto invalida o parse');
});

// ---- (b) wire end-to-end: processArticle real, fetch/LLM mockados ----
const WIRE_CHILD_SOURCE = `import { mock } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import OpenAI from 'openai';

const root = process.argv[2]; // raiz da worktree (passada pelo teste pai)
const ncHome = mkdtempSync(path.join(tmpdir(), 'nc-json-page-wire-'));
process.env.NC_HOME = ncHome;
process.on('exit', () => rmSync(ncHome, { recursive: true, force: true }));
// Env limpo: nada do shell pode vazar p/ a resolução de modelos (mesmo padrão do llm.provider).
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) delete process.env[k];
}
process.env.OPENROUTER_API_KEY = 'sk-or-teste'; // HAS_LLM on p/ extração via LLM rodar

// Corpo JSON puro como "conteúdo" visível da página (o caso react-dropzone: o site serviu o
// blob estruturado; <400 chars p/ o Readability NÃO extrair — cai no caminho LLM de propósito).
const JSON_BLOB = '{"title":"Simple HTML5 drag \\'n\\' drop zone","description":"The official React dropzone component","version":"20.0.0","license":"MIT"}';
const JSON_PAGE = '<html><head><title>react-dropzone 20.0</title></head><body><article><p>' + JSON_BLOB + '</p></article></body></html>';

// Transporte FAKE no SDK (mesmo padrão do llm.provider-client.test.js): o llm.js REAL (callJSON
// + zod) roda por cima; só o HTTP vira uma resposta canônica por schema. ZERO rede.
const Completions = OpenAI.Chat.Completions;
mock.method(Completions.prototype, 'create', async function createMock(body) {
  const name = body?.response_format?.json_schema?.name;
  if (name === 'content_selector') throw new Error('seletor derivado não deve ser necessário aqui');
  if (name === 'article') {
    return { model: 'deepseek-v4-flash', usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [{ message: { content: JSON.stringify({ title: 'Simple HTML5 drag \\'n\\' drop zone', content: JSON_BLOB, published_at: null }) } }] };
  }
  if (name === 'clean_article') {
    return { model: 'deepseek-v4-flash', usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [{ message: { content: JSON.stringify({ title: null, junk_spans: [], published_at: null }) } }] };
  }
  throw new Error('schema inesperado no wire test: ' + name);
});
// fetchSmart FAKE: toda página do host json.example devolve a página-JSON.
mock.module(pathToFileURL(path.join(root, 'src/fetch.js')).href, {
  namedExports: {
    fetchSmart: async (url) => ({ html: JSON_PAGE, url }),
    checkRobots: async () => ({ allowed: true }),
  },
});

// Logs do crawler vão p/ o console (stdout) — silencia p/ o stdout carregar SÓ o JSON final.
const { setLogSink } = await import(pathToFileURL(path.join(root, 'src/util.js')).href);
setLogSink(() => {});
const { stmts, db } = await import(pathToFileURL(path.join(root, 'src/db.js')).href);
const { processJob } = await import(pathToFileURL(path.join(root, 'src/crawl.js')).href);
const { flushEvents } = await import(pathToFileURL(path.join(root, 'src/events.js')).href);

const src = stmts.upsertSource.get({
  name: 'JsonWeekly', base_url: 'https://json.example', type: 'listing', max_index_pages: null,
});

const out = {};
try {
  // (b1) AVULSO: página-JSON não vira artigo — skip com evento json-page.
  {
    const avulsoUrl = 'https://json.example/page-avulso';
    await processJob({ url: avulsoUrl, kind: 'article', depth: 2, discovered_from: null, source_id: src.id }, {
      runId: 1, sinceDate: null, aggressive: true,
    });
    out.avulso = {
      saved: stmts.getArticleFullByUrl.get(avulsoUrl) !== undefined,
    };
    flushEvents();
    const evs = stmts.listEventsForUrl.all(avulsoUrl, 100)
      .filter((e) => e.stage === 'article' && e.status === 'skip')
      .map((e) => ({ reason: JSON.parse(e.detail).reason }));
    out.avulso.events = evs;
  }
  // (b2) Item CURADO (needs_enrich): o registro PERMANECE com o blurb do agregador.
  {
    const itemUrl = 'https://json.example/page-item';
    const issueUrl = 'https://json.example/issues/1';
    stmts.insertArticle.run({
      source_id: src.id, url: itemUrl, title: 'react-dropzone 20.0', content: 'react-dropzone 20.0 — blurb do agregador',
      content_hash: 'hash-json-item', published_at: '2026-08-10', run_id: 1, kind: 'tool',
      issue_url: issueUrl, section: null, blurb: 'blurb do agregador', content_source: 'aggregator',
      cleaned: 0, needs_enrich: 1,
    });
    await processJob({ url: itemUrl, kind: 'article', depth: 2, discovered_from: issueUrl, source_id: src.id }, {
      runId: 1, sinceDate: null, aggressive: true,
    });
    const row = stmts.getArticleFullByUrl.get(itemUrl);
    flushEvents();
    const kept = stmts.listEventsForUrl.all(itemUrl, 100)
      .filter((e) => e.stage === 'enrich' && e.status === 'kept-blurb')
      .map((e) => JSON.parse(e.detail).reason);
    out.item = {
      content: row.content, content_source: row.content_source, needs_enrich: row.needs_enrich, kept,
    };
  }
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  process.stderr.write(String((e && e.stack) || e));
  process.exitCode = 1;
} finally {
  db.close();
}
`;

test('wire: página-JSON não vira artigo — avulso é descartado com skip json-page; item curado mantém o blurb (keepAggregatorVersion)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // Script num tmp com symlink p/ o node_modules da worktree: o `import 'openai'` do filho
  // resolve para a MESMA instância de módulo que o llm.js usa (a identidade do prototype mock).
  const wireDir = mkdtempSync(path.join(os.tmpdir(), 'nc-json-page-wire-dir-'));
  try {
    symlinkSync(path.join(root, 'node_modules'), path.join(wireDir, 'node_modules'), 'dir');
    const scriptPath = path.join(wireDir, 'wire-json-page.mjs');
    writeFileSync(scriptPath, WIRE_CHILD_SOURCE, 'utf8');
    const child = spawnSync(
      process.execPath,
      ['--experimental-test-module-mocks', scriptPath, root],
      { encoding: 'utf8', timeout: 60000 },
    );
    assert.equal(child.status, 0, `filho do wire test falhou: ${child.stderr || child.stdout || child.error}`);
    assert.ok(child.stdout.trim(), 'filho sem stdout');
    const out = JSON.parse(child.stdout);
    assert.equal(out.avulso.saved, false, 'JSON cru não é salvo como artigo avulso');
    assert.deepEqual(out.avulso.events, [{ reason: 'json-page' }], 'skip com evento article/json-page');
    assert.equal(out.item.content, 'react-dropzone 20.0 — blurb do agregador', 'item curado mantém o blurb');
    assert.equal(out.item.content_source, 'aggregator', 'o JSON do alvo nunca vira o corpo do item');
    assert.equal(out.item.needs_enrich, 0, 'keepAggregatorVersion finaliza o enrich');
    assert.deepEqual(out.item.kept, ['json-page'], 'evento enrich/kept-blurb com reason json-page');
  } finally {
    rmSync(wireDir, { recursive: true, force: true });
  }
});
