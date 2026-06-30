// Eval do guard anti-bot: interstitials (Cloudflare/SSRN/captcha) vêm com 200 mas não são
// artigo e não podem ser cadastrados. Rode com: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedPage } from '../src/clean.js';

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
