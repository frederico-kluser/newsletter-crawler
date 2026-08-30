// Atalho The Rundown: detecção via probe cacheado por host (/api/articles-index) e leitura do
// índice JSON completo (1 request, sem paginação), com filtro de itens inválidos (slug/
// publishDate) — tudo com o fetcher INJETADO (_get), zero rede. Inclui o wire de processListing:
// enqueue de artigos com discovered_date = publishDate do payload (espelho do atalho Substack) e
// a ÚNICA diferença comportamental: o atalho só age em modo agressivo (robots.txt disallowa
// /api/) — modo educado cai no HTML sem tocar o endpoint.
// NC_HOME temporário ANTES do import (config.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-therundown-'));
const { isRundown, rundownArchive, RUNDOWN_INDEX_PATH } = await import('../src/therundown.js');

after(() => {
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

// ---- helpers ----
const ok = (body) => async () => ({ status: 200, headers: {}, body });

// Payload realista do /api/articles-index (shape verificado na análise da fonte).
const INDEX = [
  {
    id: 'post_aaa', slug: 'cursor-origin-hits-github-on-its-worst-day',
    title: "Cursor's Origin hits GitHub on its worst day", category: 'ai',
    publishDate: '2026-08-20T14:30:00.000Z',
  },
  {
    id: 'post_bbb', slug: 'the-ox-alpha-mystery-ends-with-z-ai',
    title: 'The Ox Alpha mystery ends with Z.ai', category: 'tech',
    publishDate: '2026-08-19T10:00:00.000Z',
  },
  {
    id: 'post_ccc', slug: 'robotics-weekly-roundup',
    title: 'Robotics weekly roundup', category: 'robotics',
    publishDate: '2026-08-18T14:30:00.000Z',
  },
];

// ---------- isRundown ----------
test('isRundown: detecta por payload — 200 + array JSON com {slug, publishDate}', async () => {
  const get = ok(JSON.stringify(INDEX));
  assert.equal(await isRundown('https://www.therundown.ai/articles', { _get: get }), true);
  assert.equal(await isRundown('https://www.therundown.ai/articles-category/ai', { _get: get }), true);
});

test('isRundown: 404 / HTML / array vazio => false, fail-safe', async () => {
  assert.equal(
    await isRundown('https://s404.example.com/articles', { _get: async () => ({ status: 404, headers: {}, body: '' }) }),
    false,
  );
  assert.equal(await isRundown('https://shtml.example.com/', { _get: ok('<html>not json</html>') }), false);
  assert.equal(await isRundown('https://sempty.example.com/', { _get: ok('[]') }), false);
});

test('isRundown: JSON array sem {slug, publishDate} em NENHUM item => false', async () => {
  const partial = JSON.stringify([{ id: 'x', title: 'sem campos' }]);
  assert.equal(await isRundown('https://spartial.example.com/', { _get: ok(partial) }), false);
});

test('isRundown: probe é cacheado por host (chamado uma vez só)', async () => {
  let calls = 0;
  const get = async () => {
    calls++;
    return { status: 200, headers: {}, body: JSON.stringify(INDEX) };
  };
  await isRundown('https://cached.example.com/a', { _get: get });
  await isRundown('https://cached.example.com/b', { _get: get });
  assert.equal(calls, 1);
});

// ---------- rundownArchive ----------
test('rundownArchive: devolve {url origin+/articles/+slug, published_at: publishDate} para o índice inteiro', async () => {
  const out = await rundownArchive('https://www.therundown.ai/articles', { _get: ok(JSON.stringify(INDEX)) });
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], {
    url: 'https://www.therundown.ai/articles/cursor-origin-hits-github-on-its-worst-day',
    published_at: '2026-08-20T14:30:00.000Z',
  });
  assert.deepEqual(out.at(-1), {
    url: 'https://www.therundown.ai/articles/robotics-weekly-roundup',
    published_at: '2026-08-18T14:30:00.000Z',
  });
});

test('rundownArchive: item sem publishDate é ignorado (slug também obrigatório)', async () => {
  const mixed = [
    { slug: 'com-data', publishDate: '2026-08-20T14:30:00.000Z', title: 'ok' },
    { slug: 'sem-data' }, // sem publishDate -> ignorado
    { publishDate: '2026-08-19T10:00:00.000Z' }, // sem slug -> ignorado
    { slug: 'data-invalida', publishDate: 'lixo' }, // publishDate inparseável -> ignorado
  ];
  const out = await rundownArchive('https://m.example.com/articles', { _get: ok(JSON.stringify(mixed)) });
  assert.deepEqual(out, [
    { url: 'https://m.example.com/articles/com-data', published_at: '2026-08-20T14:30:00.000Z' },
  ]);
});

test('rundownArchive: array vazio => [] (fail-open p/ o fluxo HTML)', async () => {
  const out = await rundownArchive('https://e.example.com/articles', { _get: ok('[]') });
  assert.equal(out.length, 0);
});

test('rundownArchive: erro HTTP / JSON inválido / corpo não-array => [], sem lançar', async () => {
  assert.equal((await rundownArchive('https://x.example.com/', { _get: async () => ({ status: 500, headers: {}, body: '' }) })).length, 0);
  assert.equal((await rundownArchive('https://x.example.com/', { _get: ok('<html>no</html>') })).length, 0);
  assert.equal((await rundownArchive('https://x.example.com/', { _get: ok(JSON.stringify({ not: 'an array' })) })).length, 0);
});

test('RUNDOWN_INDEX_PATH é /api/articles-index (endpoint disallowed por robots — só agressivo)', () => {
  assert.equal(RUNDOWN_INDEX_PATH, '/api/articles-index');
});

// ---- WIRE (processListing real, therundown.js mockado via mock.module — espelho do substack) ----
// Casos: (1) sem piso — os posts viram JOBS DE ARTIGO (kind article, fonte listing) e a frontier
// herda discovered_date = publishDate; (2) piso --since — o post abaixo NÃO é enfileirado;
// (3) modo EDUCADO (aggressive:false) — o probe isRundown NÃO é tocado e o fluxo cai no HTML
// (fetch mockado, sem LLM); o isRundown mockado LANÇA se for chamado, provando o gate.
const WIRE_CHILD_SOURCE = `import { mock } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2]; // raiz da worktree (passada pelo teste pai)
const MODE = process.argv[3]; // 'aggressive' | 'educado'
const ncHome = mkdtempSync(path.join(tmpdir(), 'nc-therundown-wire-'));
process.env.NC_HOME = ncHome;
process.on('exit', () => rmSync(ncHome, { recursive: true, force: true }));
// Env limpo: nada do shell pode vazar p/ a resolução de modelos (mesmo padrão do llm.provider).
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) delete process.env[k];
}
if (MODE !== 'educado') process.env.OPENROUTER_API_KEY = 'sk-or-teste'; // HAS_LLM on (o atalho não chama LLM)

// Índice FAKE: URL com 'com-piso' devolve um post abaixo do piso; a URL padrão, o par novo+velho.
const POSTS_NEW = [
  { url: 'https://rundown.test/articles/novo', published_at: '2026-08-13T14:30:00.000Z' },
  { url: 'https://rundown.test/articles/velho', published_at: '2026-07-30T14:30:00.000Z' },
];
const POSTS_FLOOR = [
  { url: 'https://rundown.test/articles/novo2', published_at: '2026-08-13T14:30:00.000Z' },
  { url: 'https://rundown.test/articles/velho2', published_at: '2026-07-30T14:30:00.000Z' },
];
if (MODE === 'educado') {
  // isRundown LANÇA se for chamado: em modo educado o gate (aggressive !== false) impede o probe.
  mock.module(pathToFileURL(path.join(root, 'src/therundown.js')).href, {
    namedExports: {
      isRundown: async () => { throw new Error('isRundown NÃO devia ser chamado em modo educado'); },
      rundownArchive: async () => POSTS_NEW,
    },
  });
  // HTML do fluxo normal fica mockado também: o fetch REAL nunca roda (zero rede).
  mock.module(pathToFileURL(path.join(root, 'src/fetch.js')).href, {
    namedExports: {
      fetchSmart: async () => ({ html: '<html><body><p>listagem fake</p></body></html>', harvest: [] }),
      checkRobots: async () => ({ allowed: true }),
    },
  });
} else {
  mock.module(pathToFileURL(path.join(root, 'src/therundown.js')).href, {
    namedExports: {
      isRundown: async () => true,
      rundownArchive: async (url) => (String(url).includes('com-piso') ? POSTS_FLOOR : POSTS_NEW),
    },
  });
}

// Logs do crawler vão p/ o console (stdout) — silencia p/ o stdout carregar SÓ o JSON final.
const { setLogSink } = await import(pathToFileURL(path.join(root, 'src/util.js')).href);
setLogSink(() => {});
const { stmts, db } = await import(pathToFileURL(path.join(root, 'src/db.js')).href);
const { processJob } = await import(pathToFileURL(path.join(root, 'src/crawl.js')).href);

const src = stmts.upsertSource.get({
  name: 'TheRundown', base_url: 'https://rundown.test', type: 'listing', max_index_pages: null,
});

// Drena a fila de ARTIGOS (source listing => childKind article) em ordem de claim.
function drainArticles() {
  const out = [];
  for (;;) {
    const r = stmts.claimNextArticle.get();
    if (!r) break;
    out.push({ url: r.url, kind: r.kind, date: r.discovered_date, from: r.discovered_from });
  }
  return out;
}

const out = {};
try {
  if (MODE === 'educado') {
    // Modo educado: o atalho NÃO roda (robots disallowa /api/) — o fluxo cai no HTML mockado e
    // NADA é enfileirado pelo atalho. Se o gate falhar, o isRundown mockado LANÇA aqui.
    await processJob({ url: 'https://rundown.test/articles', kind: 'listing', depth: 0, source_id: src.id }, {
      runId: 1, sinceDate: null, aggressive: false,
    });
    out.jobs = drainArticles();
  } else {
    // Caso 1 — sem piso: os 2 artigos virão jobs article e a frontier HERDA publishDate.
    await processJob({ url: 'https://rundown.test/articles', kind: 'listing', depth: 0, source_id: src.id }, {
      runId: 1, sinceDate: null, aggressive: true,
    });
    out.case1 = drainArticles();
    // Caso 2 — piso --since: o post abaixo do piso NÃO é enfileirado; o novo carrega a data.
    await processJob({ url: 'https://rundown.test/articles-com-piso', kind: 'listing', depth: 0, source_id: src.id }, {
      runId: 1, sinceDate: new Date('2026-08-01'), aggressive: true,
    });
    out.case2 = drainArticles();
  }
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  process.stderr.write(String((e && e.stack) || e));
  process.exitCode = 1;
} finally {
  db.close();
}
`;

// Roda o filho do wire com o therundown.js (e fetch.js, no educado) mockados via mock.module.
function runWire(mode) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const wireDir = mkdtempSync(path.join(os.tmpdir(), 'nc-therundown-wire-dir-'));
  try {
    symlinkSync(path.join(root, 'node_modules'), path.join(wireDir, 'node_modules'), 'dir');
    const scriptPath = path.join(wireDir, 'wire-therundown-enqueue.mjs');
    writeFileSync(scriptPath, WIRE_CHILD_SOURCE, 'utf8');
    const child = spawnSync(
      process.execPath,
      ['--experimental-test-module-mocks', scriptPath, root, mode],
      { encoding: 'utf8', timeout: 60000 },
    );
    assert.equal(child.status, 0, `filho do wire test falhou (${mode}): ${child.stderr || child.stdout || child.error}`);
    assert.ok(child.stdout.trim(), `filho sem stdout (${mode})`);
    return JSON.parse(child.stdout);
  } finally {
    rmSync(wireDir, { recursive: true, force: true });
  }
}

test('wire: atalho therundown enfileira ARTIGOS com discovered_date = publishDate e o piso --since continua valendo', () => {
  const out = runWire('aggressive');
  assert.deepEqual(out.case1, [
    { url: 'https://rundown.test/articles/novo', kind: 'article', date: '2026-08-13T14:30:00.000Z', from: 'https://rundown.test/articles' },
    { url: 'https://rundown.test/articles/velho', kind: 'article', date: '2026-07-30T14:30:00.000Z', from: 'https://rundown.test/articles' },
  ], 'cada artigo herda a data exata do payload e vira job article (fonte listing)');
  assert.deepEqual(out.case2, [
    { url: 'https://rundown.test/articles/novo2', kind: 'article', date: '2026-08-13T14:30:00.000Z', from: 'https://rundown.test/articles-com-piso' },
  ], 'artigo abaixo do piso --since não é enfileirado; o novo ainda herda a data');
});

test('wire: modo educado (aggressive:false) NÃO toca o /api/articles-index e cai no fluxo HTML', () => {
  const out = runWire('educado');
  assert.deepEqual(out.jobs, [], 'nenhum artigo enfileirado pelo atalho em modo educado');
});