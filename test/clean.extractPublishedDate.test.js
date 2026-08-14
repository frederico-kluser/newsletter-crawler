// Eval da extração de data do HTML (padrão que retorna as datas numa issue): prioriza
// JSON-LD datePublished (mesmo dentro de @graph), depois <meta article:published_time>,
// depois <time datetime>, depois atributos data-* comuns e, por ÚLTIMO, o texto visível
// (mês por extenso — o caso nodeweekly/issues/637, que não expõe a data em atributo algum).
// Fixtures inline (commitáveis). Rode com: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPublishedDate } from '../src/clean.js';
import { clampFutureDate, parseDate } from '../src/util.js';

test('extractPublishedDate: JSON-LD datePublished dentro de @graph (não confunde com dateModified)', () => {
  const ld = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', name: 'AI Weekly' },
      { '@type': 'WebSite', url: 'https://aiweekly.co' },
      {
        '@type': 'NewsArticle',
        datePublished: '2026-06-29T00:00:00+00:00',
        dateModified: '2026-06-30T00:00:00+00:00',
      },
    ],
  });
  const html = `<html><head><script type="application/ld+json">${ld}</script></head>` +
    '<body><time class="published" datetime="2026-06-25">June 25th 2026</time></body></html>';
  assert.equal(extractPublishedDate(html), '2026-06-29T00:00:00+00:00');
});

test('extractPublishedDate: fallback <meta article:published_time>', () => {
  const html = '<html><head><meta property="article:published_time" content="2026-06-20T10:00:00Z">' +
    '</head><body></body></html>';
  assert.equal(extractPublishedDate(html), '2026-06-20T10:00:00Z');
});

test('extractPublishedDate: fallback <time datetime>', () => {
  const html = '<html><body><article><time class="published" datetime="2026-06-25">' +
    'June 25th 2026</time></article></body></html>';
  assert.equal(extractPublishedDate(html), '2026-06-25');
});

test('extractPublishedDate: fallback atributos data-* (sem JSON-LD/meta/time)', () => {
  const html = '<html><body><article data-published="2026-07-02">Anúncio sem <time></article></body></html>';
  assert.equal(extractPublishedDate(html), '2026-07-02');
});

test('extractPublishedDate: sem nenhuma data -> null', () => {
  assert.equal(extractPublishedDate('<html><body><p>sem data aqui</p></body></html>'), null);
});

test('extractPublishedDate: fallback FINAL por texto visível (issue sem meta — "August 13, 2026")', () => {
  const html = '<html><body><h1>Node Weekly #637</h1><p>August 13, 2026</p>' +
    '<p>Deno 2.9, Node-GTK 4.0, Vercel AI SDK 7…</p></body></html>';
  assert.equal(extractPublishedDate(html), 'August 13, 2026');
});

test('extractPublishedDate: texto visível NÃO vence meta/time (a ordem da cadeia é preservada)', () => {
  const html = '<html><head><meta property="article:published_time" content="2026-07-02T10:00:00Z"></head>' +
    '<body><p>Published on August 13, 2026.</p></body></html>';
  assert.equal(extractPublishedDate(html), '2026-07-02T10:00:00Z');
  const timeFirst = '<html><body><time datetime="2026-06-25">June 25th 2026</time>' +
    '<p>Published on August 13, 2026.</p></body></html>';
  assert.equal(extractPublishedDate(timeFirst), '2026-06-25');
});

test('extractPublishedDate + clampFutureDate: o texto "August 13, 2026" parseia e NÃO é futuro (preservado cru)', () => {
  const hoje = new Date('2026-08-14T10:00:00.000Z');
  const raw = extractPublishedDate('<html><body><p>August 13, 2026</p></body></html>');
  assert.equal(raw, 'August 13, 2026');
  assert.equal(clampFutureDate(raw, hoje), 'August 13, 2026', 'dentro do prazo: string crua preservada');
  assert.equal(parseDate(raw).toISOString().slice(0, 10), '2026-08-13', 'parseDate entende o formato cru');
});

// ---- FIX (revisor adversarial): ordinal de dia + janela de ano no fallback de texto ----
test('extractPublishedDate: fallback FINAL aceita ORDINAL com vírgula ("August 13th, <ano>") e devolve texto parseável', () => {
  const ano = new Date().getFullYear();
  const raw = extractPublishedDate(`<html><body><p>Published on August 13th, ${ano}.</p></body></html>`);
  assert.equal(raw, `August 13, ${ano}`, 'o ordinal é removido p/ o Date nativo entender');
  assert.equal(parseDate(raw).toISOString().slice(0, 10), `${ano}-08-13`);
});

test('extractPublishedDate: fallback FINAL aceita ORDINAL sem vírgula antes do ano ("August 13th <ano>")', () => {
  const ano = new Date().getFullYear();
  const raw = extractPublishedDate(`<html><body><p>August 13th ${ano}</p></body></html>`);
  assert.equal(raw, `August 13 ${ano}`);
  assert.equal(parseDate(raw).toISOString().slice(0, 10), `${ano}-08-13`);
});

test('extractPublishedDate: prosa citando ano ANTIGO NÃO ancora a issue ("May 4, 2019" -> null)', () => {
  const html = '<html><body><p>Founded on May 4, 2019, the newsletter ships every week.</p></body></html>';
  assert.equal(extractPublishedDate(html), null, 'ano fora da janela segura: fallback NÃO dispara');
});

test('extractPublishedDate: ano FORA da janela segura não casa (futuro distante -> null)', () => {
  const fora = new Date().getFullYear() + 2;
  const html = `<html><body><p>Issue preview scheduled for August 13, ${fora}.</p></body></html>`;
  assert.equal(extractPublishedDate(html), null);
});
