// Atalho Substack: detecção (inclui domínio próprio via header/probe) e paginação do arquivo
// (/api/v1/archive por offset, page size 12), com filtro de tipo, dedup e parada por data.
// Tudo com o fetcher INJETADO (_get) — zero rede. NC_HOME temporário ANTES do import (config.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-substack-'));
const { isSubstack, substackArchive, SUBSTACK_PAGE } = await import('../src/substack.js');

after(() => {
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

const DAY = 86_400_000;
const WEEK = 7 * DAY;

// ---- helpers ----
const ok = (body, headers = {}) => async () => ({ status: 200, headers, body });

// Fake do /api/v1/archive: fatia `posts` por offset/limit da query, como o Substack real.
function archiveGet(posts) {
  return async (url) => {
    const u = new URL(url);
    const offset = Number(u.searchParams.get('offset'));
    const limit = Number(u.searchParams.get('limit'));
    return { status: 200, headers: {}, body: JSON.stringify(posts.slice(offset, offset + limit)) };
  };
}

// N posts, do mais novo ao mais antigo (sort=new), semanais a partir de `startMs`.
function makePosts(n, startMs, type = 'newsletter') {
  return Array.from({ length: n }, (_, i) => ({
    canonical_url: `https://x/p/post-${i}`,
    title: `Post ${i}`,
    post_date: new Date(startMs - i * WEEK).toISOString(),
    type,
  }));
}

// ---------- isSubstack ----------
test('isSubstack: *.substack.com resolve na hora, sem tocar a rede', async () => {
  let calls = 0;
  const get = async () => {
    calls++;
    return { status: 404, headers: {}, body: '' };
  };
  assert.equal(await isSubstack('https://astralcodex.substack.com/archive', { _get: get }), true);
  assert.equal(calls, 0);
});

test('isSubstack: domínio próprio detectado pelo header x-served-by: Substack', async () => {
  const get = ok('[]', { 'x-served-by': 'Substack' });
  assert.equal(await isSubstack('https://header.example.com/archive', { _get: get }), true);
});

test('isSubstack: domínio próprio detectado por array JSON com canonical_url', async () => {
  const get = ok(JSON.stringify([{ canonical_url: 'https://x/p/1' }]));
  assert.equal(await isSubstack('https://json.example.com/archive', { _get: get }), true);
});

test('isSubstack: não-Substack (404 / HTML) => false, fail-safe', async () => {
  assert.equal(
    await isSubstack('https://s404.example.com/issues', { _get: async () => ({ status: 404, headers: {}, body: '' }) }),
    false,
  );
  assert.equal(
    await isSubstack('https://shtml.example.com/', { _get: ok('<html>not json</html>') }),
    false,
  );
});

test('isSubstack: probe é cacheado por host (chamado uma vez só)', async () => {
  let calls = 0;
  const get = async () => {
    calls++;
    return { status: 200, headers: {}, body: JSON.stringify([{ canonical_url: 'u' }]) };
  };
  await isSubstack('https://cached.example.com/a', { _get: get });
  await isSubstack('https://cached.example.com/b', { _get: get });
  assert.equal(calls, 1);
});

// ---------- substackArchive ----------
test('substackArchive: pagina por offset e para na página curta (< 12)', async () => {
  const posts = makePosts(30, Date.parse('2026-07-01T00:00:00Z'));
  const out = await substackArchive('https://s.example.com/archive', { _get: archiveGet(posts) });
  assert.equal(out.length, 30);
  assert.equal(out[0].url, 'https://x/p/post-0');
  assert.equal(out.at(-1).url, 'https://x/p/post-29');
  assert.equal(out[0].published_at, posts[0].post_date);
});

test('substackArchive: para na página VAZIA quando o total é múltiplo de 12', async () => {
  const posts = makePosts(24, Date.parse('2026-07-01T00:00:00Z'));
  const out = await substackArchive('https://s24.example.com/archive', { _get: archiveGet(posts) });
  assert.equal(out.length, 24);
});

test('substackArchive: filtra tts/áudio (mantém newsletter/podcast/thread) e deduplica', async () => {
  const mixed = [
    { canonical_url: 'u1', title: 'a', post_date: '2026-07-01', type: 'newsletter' },
    { canonical_url: 'u1', title: 'a-audio', post_date: '2026-07-01', type: 'tts' }, // dup
    { canonical_url: 'u2', title: 'b', post_date: '2026-06-24', type: 'tts' }, // filtrado por tipo
    { canonical_url: 'u3', title: 'c', post_date: '2026-06-17', type: 'podcast' }, // mantém
  ];
  const out = await substackArchive('https://mix.example.com/archive', { _get: ok(JSON.stringify(mixed)) });
  assert.deepEqual(out.map((p) => p.url), ['u1', 'u3']);
});

test('substackArchive: --since para cedo quando a página inteira já está abaixo do piso', async () => {
  const posts = makePosts(60, Date.parse('2026-07-01T00:00:00Z')); // 60 semanais
  const since = new Date('2026-05-01T00:00:00Z');
  const out = await substackArchive('https://since.example.com/archive', { sinceDate: since, _get: archiveGet(posts) });
  // página 0 (offset 0): mais novo 2026-07-01 >= piso -> continua; página 1 (offset 12): mais novo
  // 2026-07-01 - 12*7d ~= 2026-04-08 < piso -> para. Total = 24 (2 páginas), não as 60.
  assert.equal(out.length, 24);
});

test('substackArchive: erro HTTP encerra a paginação (fail-safe, sem lançar)', async () => {
  const out = await substackArchive('https://err.example.com/archive', {
    _get: async () => ({ status: 500, headers: {}, body: '' }),
  });
  assert.equal(out.length, 0);
});

test('SUBSTACK_PAGE é 12 (cap do arquivo do Substack)', () => {
  assert.equal(SUBSTACK_PAGE, 12);
});

// ---- FIX (revisor adversarial): o enqueue do atalho Substack passa a data do payload ----
// O atalho (processListing) não é testável in-process sem rede (isSubstack/substackArchive não
// aceitam _get injetado ali), então o WIRE roda num filho com o src/substack.js MOCKADO via
// mock.module (mesmo padrão do wire de crawl.issue-date.test.js): o processListing REAL de
// crawl.js enfileira os posts; o que se verifica é a frontier herdando discovered_date.
const WIRE_CHILD_SOURCE = `import { mock } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2]; // raiz da worktree (passada pelo teste pai)
const ncHome = mkdtempSync(path.join(tmpdir(), 'nc-substack-wire-'));
process.env.NC_HOME = ncHome;
process.on('exit', () => rmSync(ncHome, { recursive: true, force: true }));
// Env limpo: nada do shell pode vazar p/ a resolução de modelos (mesmo padrão do llm.provider).
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) delete process.env[k];
}
process.env.OPENROUTER_API_KEY = 'sk-or-teste'; // HAS_LLM on (o atalho não chama LLM, mas o grafo importa)

// A rede do Substack fica MOCKADA: isSubstack=true e o arquivo vem do fake (zero rede).
// mock.module SÓ do substack.js — no grafo do filho ele é importado APENAS por crawl.js.
const POSTS_NEW = [
  { url: 'https://sub.test/p/novo', title: 'Novo', published_at: '2026-08-13T04:00:00Z' },
  { url: 'https://sub.test/p/velho', title: 'Velho', published_at: '2026-07-30T04:00:00Z' },
];
const POSTS_FLOOR = [
  { url: 'https://sub.test/p/novo2', title: 'Novo2', published_at: '2026-08-13T04:00:00Z' },
  { url: 'https://sub.test/p/velho2', title: 'Velho2', published_at: '2026-07-30T04:00:00Z' },
];
mock.module(pathToFileURL(path.join(root, 'src/substack.js')).href, {
  namedExports: {
    isSubstack: async () => true,
    substackArchive: async (url) => (String(url).includes('com-piso') ? POSTS_FLOOR : POSTS_NEW),
  },
});

// Logs do crawler vão p/ o console (stdout) — silencia p/ o stdout carregar SÓ o JSON final.
const { setLogSink } = await import(pathToFileURL(path.join(root, 'src/util.js')).href);
setLogSink(() => {});
const { stmts, db } = await import(pathToFileURL(path.join(root, 'src/db.js')).href);
const { processJob } = await import(pathToFileURL(path.join(root, 'src/crawl.js')).href);

const src = stmts.upsertSource.get({
  name: 'SubWeekly', base_url: 'https://sub.test', type: 'index', max_index_pages: null,
});

// Drena a fila de curadoria (roundups enfileirados pelo atalho) em ordem de claim.
function drainCurate() {
  const out = [];
  for (;;) {
    const r = stmts.claimNextCurate.get();
    if (!r) break;
    out.push({ url: r.url, kind: r.kind, date: r.discovered_date, from: r.discovered_from });
  }
  return out;
}

const out = {};
try {
  // Caso 1 — sem piso: os 2 posts viram roundups e a frontier HERDA p.published_at.
  await processJob({ url: 'https://sub.test/issues', kind: 'listing', depth: 0, source_id: src.id }, {
    runId: 1, sinceDate: null, aggressive: true,
  });
  out.case1 = drainCurate();
  // Caso 2 — piso --since: o post abaixo do piso NÃO é enfileirado; o novo carrega a data.
  await processJob({ url: 'https://sub.test/issues-com-piso', kind: 'listing', depth: 0, source_id: src.id }, {
    runId: 1, sinceDate: new Date('2026-08-01'), aggressive: true,
  });
  out.case2 = drainCurate();
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  process.stderr.write(String((e && e.stack) || e));
  process.exitCode = 1;
} finally {
  db.close();
}
`;

test('wire: atalho Substack enfileira roundups com discovered_date = p.published_at (e o piso --since continua valendo)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // Script num tmp com symlink p/ o node_modules da worktree: imports do filho resolvem igual.
  const wireDir = mkdtempSync(path.join(os.tmpdir(), 'nc-substack-wire-dir-'));
  try {
    symlinkSync(path.join(root, 'node_modules'), path.join(wireDir, 'node_modules'), 'dir');
    const scriptPath = path.join(wireDir, 'wire-substack-enqueue.mjs');
    writeFileSync(scriptPath, WIRE_CHILD_SOURCE, 'utf8');
    const child = spawnSync(
      process.execPath,
      ['--experimental-test-module-mocks', scriptPath, root],
      { encoding: 'utf8', timeout: 60000 },
    );
    assert.equal(child.status, 0, `filho do wire test falhou: ${child.stderr || child.stdout || child.error}`);
    assert.ok(child.stdout.trim(), 'filho sem stdout');
    const out = JSON.parse(child.stdout);
    assert.deepEqual(out.case1, [
      { url: 'https://sub.test/p/novo', kind: 'roundup', date: '2026-08-13T04:00:00Z', from: 'https://sub.test/issues' },
      { url: 'https://sub.test/p/velho', kind: 'roundup', date: '2026-07-30T04:00:00Z', from: 'https://sub.test/issues' },
    ], 'cada roundup herda a data exata do payload do post');
    assert.deepEqual(out.case2, [
      { url: 'https://sub.test/p/novo2', kind: 'roundup', date: '2026-08-13T04:00:00Z', from: 'https://sub.test/issues-com-piso' },
    ], 'post abaixo do piso --since não é enfileirado; o novo ainda herda a data');
  } finally {
    rmSync(wireDir, { recursive: true, force: true });
  }
});
