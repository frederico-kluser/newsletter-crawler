// Eval da extração de data do HTML (padrão que retorna as datas numa issue): prioriza
// JSON-LD datePublished (mesmo dentro de @graph), depois <meta article:published_time>,
// depois <time datetime>. Fixtures inline (commitáveis). Rode com: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPublishedDate } from '../src/clean.js';

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

test('extractPublishedDate: sem nenhuma data -> null', () => {
  assert.equal(extractPublishedDate('<html><body><p>sem data aqui</p></body></html>'), null);
});
