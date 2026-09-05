// Alvos PDF nunca viram HTML: o Chromium inicia um DOWNLOAD na navegação e o page.goto
// rejeita com "Download is starting" — antes, o job falhava e o item curado era re-enfileirado
// p/ enriquecer em TODA run (loop eterno de erros, ex.: momjian.us/*.pdf). O fix: detectar
// cedo (URL .pdf), no content-type (application/pdf sem extensão) e no erro do goto — o fetch
// devolve o marker { pdf: true } e o artigo mantém o blurb (keepAggregatorVersion).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// NC_HOME temporário ANTES do import (fetch.js -> config.js): no load, config.js cria/semeia o
// NC_HOME REAL do usuário e carrega o .env dele. Import dinâmico porque o `import`
// estático é IÇADO — rodaria antes desta linha.
process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-fetch-pdf-'));
after(() => rmSync(process.env.NC_HOME, { recursive: true, force: true }));
const { isPdfUrl, isDownloadError, fetchSmart } = await import('../src/fetch.js');

test('isPdfUrl: extensão .pdf (case-insensitive, query/hash ok, path prefix não engana)', () => {
  assert.equal(isPdfUrl('https://momjian.us/main/writings/pgsql/wal.pdf'), true);
  assert.equal(isPdfUrl('https://x.example/a.PDF'), true);
  assert.equal(isPdfUrl('https://x.example/dir/a.pdf?download=1'), true);
  assert.equal(isPdfUrl('https://x.example/a.pdf#page=2'), true);
  assert.equal(isPdfUrl('https://x.example/a.pdfx'), false); // prefixo não basta
  assert.equal(isPdfUrl('https://x.example/a.html'), false);
  assert.equal(isPdfUrl('https://x.example/a?file=b.pdf'), false); // query não conta
  assert.equal(isPdfUrl('https://x.example/'), false);
  assert.equal(isPdfUrl(''), false);
  assert.equal(isPdfUrl('not a url'), false);
});

test('isDownloadError: só o erro de download do Playwright conta', () => {
  assert.equal(isDownloadError(new Error('Download is starting')), true);
  assert.equal(isDownloadError(new Error('page.goto: Download is starting')), true);
  assert.equal(isDownloadError(new Error('net::ERR_NAME_NOT_RESOLVED')), false);
  assert.equal(isDownloadError(new Error('timeout exceeded')), false);
  assert.equal(isDownloadError(null), false);
  assert.equal(isDownloadError(undefined), false);
});

test('fetchSmart: URL .pdf devolve marker pdf SEM rede (nem static, nem browser)', async () => {
  const out = await fetchSmart('https://pdfs.example.com/slides/wal.pdf', { profile: 'article' });
  assert.equal(out.pdf, true);
  assert.equal(out.html, null);
  assert.ok(out.url);
});
