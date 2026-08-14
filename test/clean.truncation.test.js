// P5/P6b da captura 2026-08-14: detecção de fim truncado por botão de UI (release notes do
// GitHub), remoção do gatilho terminal e poda determinística de moldura de página (fallback
// quando a limpeza IA falha). Helpers puros de parse-core — sem rede, sem LLM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import {
  detectTruncatedEnd, stripTrailingTrigger, prunePageFrame,
} from '../src/clean.js';

// ---- detectTruncatedEnd: casos reais e negativos ----
test('detectTruncatedEnd: fim em botão de UI do GitHub (caso real da Vitest)', () => {
  const tail =
    'Lowers peak memory usage when using --changed on a large graph  -  by @jszumski in #10866 (9f23f)\n' +
    'browser: Serve framework assets as immutable  -  by @sheremet-va in #10729 (7af87)\n\n' +
    '    View changes on GitHub';
  assert.equal(detectTruncatedEnd(tail), true);
});

test('detectTruncatedEnd: variantes do gatilho', () => {
  assert.equal(detectTruncatedEnd('...porque o corpo termina aqui. View on GitHub'), true);
  assert.equal(detectTruncatedEnd('...changelog completo. View all changes'), true);
  assert.equal(detectTruncatedEnd('...veja mais. Show more'), true);
  assert.equal(detectTruncatedEnd('...continue lendo. Read more'), true);
});

test('detectTruncatedEnd: conteúdo normal não dispara', () => {
  assert.equal(detectTruncatedEnd('Some real content ends here. And continues nicely.'), false);
  assert.equal(detectTruncatedEnd('A final paragraph keeps the extracted text above the 400-char minimum.'), false);
  // "view changes" no MEIO do texto — bem antes dos últimos 100 chars — não conta
  const mid = 'Click the "View changes on GitHub" button in the release notes to see the full diff between the two versions, ' +
    'and then read our complete announcement below with all the details about what changed, why it changed, and how to migrate.';
  assert.equal(detectTruncatedEnd(mid), false);
  assert.equal(detectTruncatedEnd(''), false);
  assert.equal(detectTruncatedEnd(null), false);
});

// ---- stripTrailingTrigger: só o gatilho TERMINAL sai; prosa fica ----
test('stripTrailingTrigger: remove o botão do fim (caso real da Vitest)', () => {
  const tail =
    'browser: Serve framework assets as immutable  -  by @sheremet-va in #10729 (7af87)\n\n' +
    '    View changes on GitHub';
  assert.equal(
    stripTrailingTrigger(tail),
    'browser: Serve framework assets as immutable  -  by @sheremet-va in #10729 (7af87)',
  );
});

test('stripTrailingTrigger: NÃO come prosa que termina com o gatilho como parte da frase', () => {
  // "…want to read more": "read more" não abre frase/linha — prosa intacta
  assert.equal(stripTrailingTrigger("You'll want to read more"), "You'll want to read more");
  assert.equal(stripTrailingTrigger('...and we hope you subscribe to our newsletter.'), '...and we hope you subscribe to our newsletter.');
});

test('stripTrailingTrigger: gatilho como frase TERMINAL sai (com fronteira de frase)', () => {
  assert.equal(stripTrailingTrigger('...see the full details. Read more'), '...see the full details.');
  assert.equal(stripTrailingTrigger('...nova versão. View all changes'), '...nova versão.');
});

test('stripTrailingTrigger: sem gatilho -> intacto', () => {
  const s = 'conteúdo normal sem gatilho nenhum.';
  assert.equal(stripTrailingTrigger(s), s);
});

// ---- prunePageFrame: moldura de CMS no começo/fim (caso real do meiert.com) ----
const MEIER_FIXTURE = new URL('../test/fixtures/meiert-5-npx-helpers.html', import.meta.url);
const VITEST_FIXTURE = new URL('../test/fixtures/vitest-release.html', import.meta.url);

test('prunePageFrame: remove byline + rodapé da página real do meiert.com', () => {
  const html = readFileSync(MEIER_FIXTURE, 'utf8');
  const dom = new JSDOM(html, { url: 'https://meiert.com/blog/5-npx-helpers/' });
  const art = new Readability(dom.window.document).parse();
  const text = art.textContent.trim();
  // o texto cru reproduz a captura real: moldura nos DOIS lados
  assert.ok(text.startsWith('Published on Aug'), 'fixture: byline no topo');
  assert.ok(text.endsWith('but do be critical.)'), 'fixture: rodapé no fim');

  const pruned = prunePageFrame(text);
  assert.ok(pruned.startsWith('npx allows you to run Node.js packages right away.'), 'byline removida');
  assert.ok(pruned.endsWith('we can only be well if we take good care of everyone.'), 'rodapé removido');
  assert.ok(pruned.length < text.length, 'só REMOVE (nunca adiciona)');
});

test('prunePageFrame: remove o banner de pré-release do GitHub (texto cru do Readability)', () => {
  const html = readFileSync(VITEST_FIXTURE, 'utf8');
  const dom = new JSDOM(html, { url: 'https://github.com/vitest-dev/vitest/releases/tag/v5.0.0-rc.1' });
  const text = new Readability(dom.window.document).parse().textContent.trim();
  assert.ok(/pre-release/i.test(text.slice(0, 200)), 'fixture: banner no topo');
  const pruned = prunePageFrame(text);
  assert.ok(pruned.startsWith('🚨 Breaking Changes'), 'banner removido');
  assert.ok(!/immutable release/i.test(pruned), 'nenhum resquício do banner');
});

test('prunePageFrame: NÃO toca conteúdo real (README/notas sem moldura)', () => {
  const content = 'activitypub: use raw content for source in notes.private (3ddadff)\nadd image attachments to chat message notes (abb9663)';
  assert.equal(prunePageFrame(content), content);
  const release = '🚨 Breaking Changes\n\nInline projects extend the root config by default  -  by @sheremet-va in #10750 (fec00)';
  assert.equal(prunePageFrame(release), release);
});

test('prunePageFrame: CTA/footer no fim saem quando são frase terminal; prosa com "subscribe" fica', () => {
  assert.equal(prunePageFrame('...real content. Subscribe to the changelog'), '...real content.');
  assert.equal(prunePageFrame('...and we hope you subscribe to our newsletter.'), '...and we hope you subscribe to our newsletter.');
  assert.equal(prunePageFrame('...final thoughts. Related posts: none today'), '...final thoughts.');
  assert.equal(prunePageFrame('...the article ends. © 2026 Acme Corp'), '...the article ends.');
});
