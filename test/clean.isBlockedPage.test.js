// Eval do guard anti-bot: interstitials (Cloudflare/SSRN/captcha) vêm com 200 mas não são
// artigo e não podem ser cadastrados. Rode com: npm test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// NC_HOME temporário ANTES do import (clean.js -> governor.js -> config.js): no load, config.js cria/semeia o
// NC_HOME REAL do usuário e carrega o .env dele. Import dinâmico porque o `import`
// estático é IÇADO — rodaria antes desta linha.
process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-clean-blocked-'));
after(() => rmSync(process.env.NC_HOME, { recursive: true, force: true }));
const { isBlockedPage } = await import('../src/clean.js');

test('isBlockedPage: interstitials anti-bot -> true', () => {
  assert.equal(isBlockedPage('Just a moment...', 'Enable JavaScript and cookies to continue'), true);
  assert.equal(isBlockedPage('Attention Required! | Cloudflare', ''), true);
  assert.equal(isBlockedPage('Performing security verification', ''), true);
  assert.equal(isBlockedPage('', 'Checking if the site connection is secure'), true);
});

test('isBlockedPage: artigo real -> false', () => {
  assert.equal(
    isBlockedPage('How GPT-5 helped immunologist solve a mystery', 'A real article body about AI and science...'),
    false,
  );
});
