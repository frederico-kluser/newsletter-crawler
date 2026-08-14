// FIX Achado 2 (captura 2026-08-14): 2 itens da llmnews.ai com data ANTERIOR ao --since
// 2026-08-07 foram salvos ("OCR 4.1" 07-16; "DeepSeek V4 Flash 0731" 07-31). Causa: o filtro
// do processListing só barra itens DATADOS na própria listagem (`if (sinceDate && d && d <
// sinceDate) continue`) — item com d===null enfileira; a data dele só é RESOLVIDA depois
// (clean LLM publicado/fallback sibling), e o guard cedo do processArticle já passou com null.
// O fix: guarda PÓS-HOC no caminho direto não-enriching — após a limpeza e ANTES do insert,
// data final < --since => skip com evento below-since (detail {published, posthoc:true}) +
// dateSeen. Item curado de issue PERMANECE imune (a âncora é a data da issue).
// Aqui: wire end-to-end (processArticle real com fetch/LLM mockados, sem rede — mesmo padrão
// do crawl.issue-date.test.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-floor-posthoc-'));
const { db } = await import('../src/db.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

const WIRE_CHILD_SOURCE = `import { mock } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import OpenAI from 'openai';

const root = process.argv[2]; // raiz da worktree (passada pelo teste pai)
const ncHome = mkdtempSync(path.join(tmpdir(), 'nc-floor-posthoc-wire-'));
process.env.NC_HOME = ncHome;
process.on('exit', () => rmSync(ncHome, { recursive: true, force: true }));
// Env limpo: nada do shell pode vazar p/ a resolução de modelos (mesmo padrão do llm.provider).
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) delete process.env[k];
}
process.env.OPENROUTER_API_KEY = 'sk-or-teste'; // HAS_LLM on p/ o clean por IA rodar

// Página do alvo SEM data machine-readable: o published_at só chega VIA CLEAN LLM (o caso
// llmnews: listagem sem data pareada, alvo velho). Prosa >= 400 chars p/ o Readability extrair.
const NO_DATE_PAGE = '<html><head><title>Post sem data</title></head><body><article><h1>Post sem data</h1><p>' +
  'This is a long-form article body written to keep the extracted text comfortably above the 400-char minimum that Readability requires before we treat it as an article, with no date metadata anywhere on the page, which is exactly the llmnews case from the capture where the listing had no parseable date for the item at all.' +
  '</p><p>A final paragraph repeats enough words to guarantee the threshold is met regardless of how the HTML is normalized by the parser in this test environment.</p></article></body></html>';
// Página com data machine-readable (meta article:published_time) DENTRO do piso.
const DATED_PAGE = '<html><head><meta property="article:published_time" content="2026-08-10T12:00:00Z"><title>Post no piso</title></head><body><article><h1>Post no piso</h1><p>' +
  'This is a long-form article body written to keep the extracted text comfortably above the 400-char minimum that Readability requires before we treat it as an article, published inside the since window so it must be saved normally.' +
  '</p><p>A final paragraph repeats enough words to guarantee the threshold is met regardless of how the HTML is normalized by the parser in this test environment, adding a little more prose here so the text length stays safely above the minimum even after whitespace collapsing and other normalization steps.' +
  '</p></article></body></html>';

// Transporte FAKE no SDK (mesmo padrão do llm.provider-client.test.js): o llm.js REAL (callJSON
// + zod) roda por cima; só o HTTP vira uma resposta canônica por schema. ZERO rede.
const Completions = OpenAI.Chat.Completions;
let curCase = 'a';
mock.method(Completions.prototype, 'create', async function createMock(body) {
  const name = body?.response_format?.json_schema?.name;
  if (name === 'clean_article') {
    // A data do alvo só existe AQUI (a página não tinha meta): caso a/b resolvem 08-01
    // (ANTES do --since 08-07); caso c (controle) não resolve nada.
    const published_at = curCase === 'a' || curCase === 'b' ? '2026-08-01' : null;
    return { model: 'deepseek-v4-flash', usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [{ message: { content: JSON.stringify({ title: null, junk_spans: [], published_at }) } }] };
  }
  if (name === 'content_selector') throw new Error('seletor derivado não deve ser necessário aqui');
  throw new Error('schema inesperado no wire test: ' + name);
});
// fetchSmart FAKE por host: old.example/item.example = página sem data; new.example = datada.
mock.module(pathToFileURL(path.join(root, 'src/fetch.js')).href, {
  namedExports: {
    fetchSmart: async (url) => {
      const html = String(url).startsWith('https://new.example/') ? DATED_PAGE : NO_DATE_PAGE;
      return { html, url };
    },
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
  name: 'FloorWeekly', base_url: 'https://floor.example', type: 'listing', max_index_pages: null,
});
const SINCE = new Date('2026-08-07');

const out = {};
try {
  // (a) AVULSO, item SEM data na listagem (enqueue sem discovered_date), alvo velho resolvido
  // só no clean -> a guarda pós-hoc descarta ANTES do insert.
  {
    const url = 'https://old.example/post-a';
    curCase = 'a';
    await processJob({ url, kind: 'article', depth: 2, discovered_from: null, source_id: src.id }, {
      runId: 1, sinceDate: SINCE, aggressive: true,
    });
    out.a = {
      saved: stmts.getArticleFullByUrl.get(url) !== undefined,
    };
    flushEvents();
    const evs = stmts.listEventsForUrl.all(url, 100)
      .filter((e) => e.stage === 'article' && e.status === 'skip')
      .map((e) => JSON.parse(e.detail));
    out.a.events = evs;
  }
  // (b) Item CURADO de issue PERMANECE imune: o alvo resolve data velha no clean, mas a âncora
  // do registro é a data da issue (enrichAnchorDate) e a guarda pós-hoc não pisa item de issue.
  {
    const url = 'https://item.example/post-b';
    const issueUrl = 'https://floor.example/issues/1';
    curCase = 'b';
    stmts.insertArticle.run({
      source_id: src.id, url, title: 'Item curado', content: 'Item curado — blurb do agregador',
      content_hash: 'hash-floor-item', published_at: '2026-08-13', run_id: 1, kind: 'news',
      issue_url: issueUrl, section: null, blurb: 'blurb do agregador', content_source: 'aggregator',
      cleaned: 0, needs_enrich: 1,
    });
    await processJob({ url, kind: 'article', depth: 2, discovered_from: issueUrl, source_id: src.id }, {
      runId: 1, sinceDate: SINCE, aggressive: true,
    });
    const row = stmts.getArticleFullByUrl.get(url);
    out.b = { published: row.published_at, content_source: row.content_source, needs_enrich: row.needs_enrich };
  }
  // (c) Controle: avulso com data própria DENTRO do piso continua sendo salvo normalmente.
  {
    const url = 'https://new.example/post-c';
    curCase = 'c';
    await processJob({ url, kind: 'article', depth: 2, discovered_from: null, source_id: src.id }, {
      runId: 1, sinceDate: SINCE, aggressive: true,
    });
    const row = stmts.getArticleFullByUrl.get(url);
    out.c = { saved: row !== undefined, published: row ? row.published_at : null };
  }
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  process.stderr.write(String((e && e.stack) || e));
  process.exitCode = 1;
} finally {
  db.close();
}
`;

test('wire: avulso sem data na listagem com alvo abaixo do piso resolvido no clean é descartado pós-hoc; item de issue imune; avulso no piso salva', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // Script num tmp com symlink p/ o node_modules da worktree: o `import 'openai'` do filho
  // resolve para a MESMA instância de módulo que o llm.js usa (a identidade do prototype mock).
  const wireDir = mkdtempSync(path.join(os.tmpdir(), 'nc-floor-posthoc-wire-dir-'));
  try {
    symlinkSync(path.join(root, 'node_modules'), path.join(wireDir, 'node_modules'), 'dir');
    const scriptPath = path.join(wireDir, 'wire-floor-posthoc.mjs');
    writeFileSync(scriptPath, WIRE_CHILD_SOURCE, 'utf8');
    const child = spawnSync(
      process.execPath,
      ['--experimental-test-module-mocks', scriptPath, root],
      { encoding: 'utf8', timeout: 60000 },
    );
    assert.equal(child.status, 0, `filho do wire test falhou: ${child.stderr || child.stdout || child.error}`);
    assert.ok(child.stdout.trim(), 'filho sem stdout');
    const out = JSON.parse(child.stdout);
    // (a) item sem data na listagem, data do alvo resolvida SÓ no clean -> descartado pós-hoc
    assert.equal(out.a.saved, false, 'avulso com data resolvida abaixo do piso não é salvo');
    assert.equal(out.a.events.length, 1, 'um skip no trace');
    assert.equal(out.a.events[0].reason, 'below-since');
    assert.equal(out.a.events[0].posthoc, true, 'detail marca posthoc: true');
    assert.equal(out.a.events[0].published, '2026-08-01');
    // (b) item curado de issue: a data do alvo (velha, via clean) NÃO pisa o registro
    assert.equal(out.b.published, '2026-08-13', 'âncora da issue preservada');
    assert.equal(out.b.content_source, 'target', 'o corpo do alvo ainda enriquece o item');
    assert.equal(out.b.needs_enrich, 0);
    // (c) controle: avulso dentro do piso segue o fluxo normal
    assert.equal(out.c.saved, true);
    assert.ok(out.c.published.startsWith('2026-08-10'), 'data da meta preservada no insert');
  } finally {
    rmSync(wireDir, { recursive: true, force: true });
  }
});
