// Regras de URL plausível (isPlausibleUrl) — o guard que mata os placeholders de truncamento da
// curadoria ("github.com/...", "https://..": 32 artigos PUBLICADOS + 31 frontier em 2026-10-10) —
// e a extensão do classifyFetchError (conexão derrubada = blocked, não 'other').
// Fixtures = URLs REAIS apanhadas no acervo pelo trace --llm-dev.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// CONTRATO DE ISOLAMENTO: NC_HOME tmp ANTES do 1º import que alcança config.js/db.js.
process.env.NC_HOME = mkdtempSync(path.join(tmpdir(), 'nc-plausible-'));
after(() => rmSync(process.env.NC_HOME, { recursive: true, force: true }));
const { isPlausibleUrl } = await import('../src/util.js');
const { consolidateItems } = await import('../src/curate.js');
const { classifyFetchError } = await import('../src/audit.js');

// ---- isPlausibleUrl: os padrões REAIS de lixo do acervo ----

test('isPlausibleUrl rejeita os placeholders de truncamento reais', () => {
  const lixo = [
    'https://..', 'https://.', 'https://github.com/...', 'https://www.papercall.io/...',
    'https://x.com/kashberg_0/status/...', 'https://github.com/.../dev.css',
    'https://eurorust.eu/...', 'https://github.com/paulmillr/...',
    'https://www.linkedin.com/in/...', 'https://medium.com/...',
    'https://example.com/…', 'https://example.com/foo/...', 'http://x/../',
  ];
  for (const u of lixo) assert.equal(isPlausibleUrl(u), false, `devia rejeitar: ${u}`);
  // E mais os óbvios de host inválido.
  for (const u of ['ftp://ex.com/a', 'not a url', 'https://localhost/x', 'https://ex', '']) {
    assert.equal(isPlausibleUrl(u), false, `devia rejeitar: ${u}`);
  }
});

test('isPlausibleUrl aceita URLs legítimas (anti falso-positivo)', () => {
  const boas = [
    'https://github.com/rust-lang/rust/pull/12345',
    'https://www.stephaniewalter.com/blog/foo-bar/',
    'https://ex.com/a...b', // reticências no MEIO de um slug: legítimo
    'https://ex.com/foo/bar...', // slug que TERMINA em reticências sem '/' antes: legítimo
    'https://sub.domain.co.uk:8080/path?q=hello%20world#frag',
    'http://ex.com', 'https://newsletter.awesome.dev/issues/643',
    'https://x.com/user/status/1234567890',
  ];
  for (const u of boas) assert.equal(isPlausibleUrl(u), true, `devia aceitar: ${u}`);
});

// ---- consolidateItems: o item truncado NUNCA vira artigo ----

test('consolidateItems descarta itens com URL implausível como invalid', () => {
  const results = [{
    issue_date: '2026-10-09',
    items: [
      { url: 'https://github.com/rust-lang/rust/releases', title: 'boa', kind: 'release', blurb: 'x' },
      { url: 'https://github.com/...', title: 'truncada', kind: 'news', blurb: 'x' },
      { url: 'https://..', title: 'quase vazia', kind: 'news', blurb: 'x' },
      { url: 'https://x.com/foo/status/...', title: 'truncada 2', kind: 'news', blurb: 'x' },
    ],
  }];
  const { items, skipped } = consolidateItems(results, { baseUrl: 'https://newsletter.dev/issue/1' });
  assert.deepEqual(items.map((i) => i.url), ['https://github.com/rust-lang/rust/releases']);
  assert.equal(skipped.invalid, 3, 'os 3 placeholders contam como invalid (auditável)');
});

// ---- classifyFetchError: conexão derrubada ≠ other ----

test('classifyFetchError: conexão derrubada vira blocked; dead/timeout/http preservados', () => {
  assert.equal(classifyFetchError('page.goto: net::ERR_CONNECTION_CLOSED at https://www.papercall.io/...'), 'blocked');
  assert.equal(classifyFetchError('read ECONNRESET'), 'blocked');
  assert.equal(classifyFetchError('unexpected server response (ERR_EMPTY_RESPONSE)'), 'blocked');
  assert.equal(classifyFetchError('getaddrinfo ENOTFOUND blog.reco.ai'), 'dead-target');
  assert.equal(classifyFetchError('connect ECONNREFUSED 91.98.198.236:443'), 'dead-target');
  assert.equal(classifyFetchError('net::ERR_SSL_PROTOCOL_ERROR at https://www.mastro.ai/x'), 'dead-target');
  assert.equal(classifyFetchError('ETIMEDOUT'), 'timeout');
  assert.equal(classifyFetchError('status code 403'), 'blocked');
  assert.equal(classifyFetchError('status code 500'), 'http');
  assert.equal(classifyFetchError('qualquer coisa'), 'other');
});
