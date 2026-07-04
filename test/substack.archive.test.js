// Atalho Substack: detecção (inclui domínio próprio via header/probe) e paginação do arquivo
// (/api/v1/archive por offset, page size 12), com filtro de tipo, dedup e parada por data.
// Tudo com o fetcher INJETADO (_get) — zero rede. NC_HOME temporário ANTES do import (config.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
