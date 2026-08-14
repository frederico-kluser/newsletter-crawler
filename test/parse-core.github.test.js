// P5 (release notes do GitHub terminando no botão "View changes on GitHub") e P6a (quebras de
// linha entre blocos) da captura 2026-08-14. Usa a página REAL da release do Vitest 5.0 RC
// (fixture trimada — reproduz exatamente o textContent do Readability da página inteira) e o
// README do NodeBB (lista aninhada real). Sem rede, sem LLM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import {
  blockTextFromHtml, htmlBlockText, githubReleaseText, isGithubUrl,
} from '../src/clean.js';

const VITEST_URL = 'https://github.com/vitest-dev/vitest/releases/tag/v5.0.0-rc.1';
const VITEST_FIXTURE = new URL('../test/fixtures/vitest-release.html', import.meta.url);

const readabilityOf = (html, url) => {
  const dom = new JSDOM(html, { url });
  try {
    return new Readability(dom.window.document).parse();
  } finally {
    dom.window.close();
  }
};

// ---- P6a: blockTextFromHtml / htmlBlockText ----
test('htmlBlockText: insere quebras entre blocos em HTML minificado (sem newline no fonte)', () => {
  // HTML minificado: <h1> e <p> colados — o textContent colaria "CSS and DOM.TermDOM is…"
  const minified = '<article><h1>TermDOM</h1><p>CSS and DOM.</p><p>TermDOM is a terminal UI.</p><ul><li>item um</li><li>item dois</li></ul></article>';
  const art = { content: minified };
  const text = htmlBlockText(art);
  // UMA '\n' por fronteira de bloco (sem outra normalização)
  assert.equal(
    text,
    'TermDOM\nCSS and DOM.\nTermDOM is a terminal UI.\nitem um\nitem dois',
  );
});

test('htmlBlockText: HTML com newline no fonte ganha SÓ novos \n (diff é só newline)', () => {
  const html =
    '<article><h1>Vitest 5.0 RC</h1>\n<p>First paragraph.</p>\n<p>Second paragraph with <strong>bold</strong> text.</p></article>';
  const art = { content: html };
  const text = htmlBlockText(art);
  // textContent cru (JSDOM) vs bloco: a diferença é só inserção de \n (nunca palavras)
  const plain = '<article><h1>Vitest 5.0 RC</h1>\n<p>First paragraph.</p>\n<p>Second paragraph with <strong>bold</strong> text.</p></article>'
    .replace(/<[^>]+>/g, '');
  const added = text.length - plain.trim().length;
  assert.ok(added >= 2, `esperava newlines novos, veio ${added}`);
  const stripped = text.replace(/\n/g, '');
  assert.equal(stripped, plain.replace(/\n/g, '').trim(), 'removendo os \n, o texto é o mesmo (só newline a mais)');
});

test('htmlBlockText: `<br>` vira quebra de linha (código inline sem separação — DeepSeek)', () => {
  const art = { content: '<p>Agent = Model + Harness<br>Tool = Model + Workspace</p>' };
  assert.equal(htmlBlockText(art), 'Agent = Model + Harness\nTool = Model + Workspace');
});

test('htmlBlockText: falha -> textContent atual (fail-open)', () => {
  assert.equal(htmlBlockText(null), '');
  assert.equal(htmlBlockText({}), '');
  assert.equal(htmlBlockText({ content: null, textContent: '  caí no textContent  ' }), 'caí no textContent');
});

test('blockTextFromHtml: fragmento solto (sem <body>) também serializa', () => {
  const t = blockTextFromHtml('<p>a</p><p>b</p>');
  assert.equal(t, 'a\nb');
  // vazio: '' (falsy) — quem chama cai no textContent (fail-open)
  assert.equal(blockTextFromHtml(''), '');
});

// ---- P5: o caso REAL da Vitest ----
test('P5 (fixture real): Readability captura o corpo INTEIRO; o fim é o botão de UI', () => {
  const html = readFileSync(VITEST_FIXTURE, 'utf8');
  const art = readabilityOf(html, VITEST_URL);
  const tc = art.textContent.trim();
  // a captura real (3758ch) é o markdown-body COMPLETO: 44 refs de PR e o botão no fim —
  // o "truncamento" é o corpo terminar no botão de UI, não perda de conteúdo.
  assert.ok(tc.endsWith('View changes on GitHub'), 'corpo termina no botão');
  assert.equal((tc.match(/#\d{4,6}/g) || []).length, 44, 'todas as PRs da release presentes');
});

test('P5 (fixture real): githubReleaseText re-extrai o container da release SEM o botão', () => {
  const html = readFileSync(VITEST_FIXTURE, 'utf8');
  const out = githubReleaseText(html);
  assert.ok(out, '2º passe achou o container');
  assert.ok(out.startsWith('🚨 Breaking Changes'), 'container = corpo da release (sem banner)');
  assert.ok(out.includes('browser: Serve framework assets as immutable'), 'lista de PRs preservada');
  assert.ok(!/view changes on github/i.test(out), 'botão de UI removido');
});

test('P5 (fixture real): o 2º passe tem quebras de bloco (fronteiras de li/ul)', () => {
  const html = readFileSync(VITEST_FIXTURE, 'utf8');
  const out = githubReleaseText(html);
  const re = /Lowers peak memory usage[\s\S]*?\(9f23f\)\n\nbrowser: Serve framework assets as immutable/;
  assert.ok(re.test(out), 'itens de PR em linhas separadas (não colados)');
});

test('P5: página INTEIRA com nav/sidebar ANTES do container — o gatilho do corpo vence (não o 1º da página)', () => {
  // O cenário real: a página inteira (header/nav com "View all changes" antes do container) —
  // a fixture das releases é TRIMADA ao container; aqui o container é embutido numa página
  // completa. O 1º gatilho em ordem de documento (nav) subiria até um ancestral enorme e
  // reintroduziria lixo — o certo é o gatilho do corpo da release (último em ordem de documento).
  const container = readFileSync(VITEST_FIXTURE, 'utf8');
  const fullPage = `<!DOCTYPE html><html><head><title>Release v5.0.0-rc.1 · vitest-dev/vitest</title></head><body>
<header class="site-header"><a href="/">GitHub</a></header>
<main>
  <nav aria-label="Repository">
    <a href="/vitest-dev/vitest">Code</a>
    <a href="/vitest-dev/vitest/pulls">Sidebar navegação demo</a>
    <a href="/vitest-dev/vitest/releases">View all changes</a>
  </nav>
  ${container}
</main>
<footer><a href="/site/terms">Terms</a></footer>
</body></html>`;
  const out = githubReleaseText(fullPage);
  assert.ok(out, '2º passe acha o container da release');
  assert.ok(out.startsWith('🚨 Breaking Changes'), 'container = corpo da release, NÃO a página inteira');
  assert.ok(out.includes('browser: Serve framework assets as immutable'), 'lista de PRs preservada');
  assert.ok(!/view all changes/i.test(out), 'gatilho do nav removido');
  assert.ok(!/sidebar navegação demo/i.test(out), 'nav/sidebar antes do container não vira conteúdo');
});

test('P5: githubReleaseText sem botão -> null (fail-open); URL não-github -> isGithubUrl false', () => {
  assert.equal(githubReleaseText('<article><p>sem botão nenhum aqui.</p></article>'), null);
  assert.equal(githubReleaseText('<p>View changes on GitHub</p>'), null, 'sem 400 chars não há container');
  assert.equal(isGithubUrl(VITEST_URL), true);
  assert.equal(isGithubUrl('https://www.github.com/vitest-dev/vitest'), true);
  assert.equal(isGithubUrl('https://meiert.com/blog/5-npx-helpers/'), false);
  assert.equal(isGithubUrl('url-inválida'), false);
});
