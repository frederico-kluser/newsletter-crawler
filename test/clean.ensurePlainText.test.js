// Guarda de texto puro no armazenamento (anti "HTML cru" nas fichas): converte SÓ quando a
// string é markup HTML de verdade — nunca mexe em prosa/código com "<" solto (a < b, Array<T>,
// um "<div>" citado só na abertura). Puro/testável — espelha o padrão de clean.sanityCleaned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensurePlainText, looksLikeHtml } from '../src/clean.js';

test('ensurePlainText: HTML com tags vira texto', () => {
  assert.equal(ensurePlainText('<p>Hello <strong>world</strong></p>'), 'Hello world');
});

test('ensurePlainText: tag com atributo / link é achatada', () => {
  assert.equal(ensurePlainText('<a href="/v5">Fastify 5.9</a> released'), 'Fastify 5.9 released');
});

test('ensurePlainText: texto puro com "<" NÃO é tocado (o guard crítico)', () => {
  for (const s of ['if a < b then it holds', 'Array<T> and Map<K,V>', 'wrap it in a <div> inline']) {
    assert.equal(ensurePlainText(s), s);
  }
});

test('ensurePlainText: entidades são decodificadas preservando "<" cru como texto', () => {
  assert.equal(ensurePlainText('Tom &amp; Jerry &lt;3'), 'Tom & Jerry <3');
  assert.equal(ensurePlainText('<p>a &amp; b</p>'), 'a & b');
});

test('ensurePlainText: blurb realista com tags sai sem "<"/">"', () => {
  const out = ensurePlainText('<p>The <strong>Fastify</strong> team shipped <a href="/v5">v5.9</a>.</p>');
  assert.ok(out.includes('Fastify') && out.includes('v5.9'));
  assert.ok(!out.includes('<') && !out.includes('>'));
});

test('ensurePlainText: markdown legítimo é preservado', () => {
  const md = '## Heading\n\n- item *one*';
  assert.equal(ensurePlainText(md), md);
});

test('ensurePlainText: script/style são descartados (não vazam código)', () => {
  const out = ensurePlainText('<div>Real text</div><script>var x=1;</script>');
  assert.equal(out, 'Real text');
  assert.ok(!out.includes('var x'));
});

test('ensurePlainText: idempotente', () => {
  for (const s of ['<p>Hello <b>world</b></p>', 'texto puro', 'Array<T>', 'Tom &amp; Jerry']) {
    assert.equal(ensurePlainText(ensurePlainText(s)), ensurePlainText(s));
  }
});

test('ensurePlainText: nulos/vazios não lançam', () => {
  assert.equal(ensurePlainText(''), '');
  assert.equal(ensurePlainText(null), '');
  assert.equal(ensurePlainText(undefined), '');
});

test('looksLikeHtml: predicado', () => {
  for (const s of ['<p>x</p><p>y</p>', '<a href="x">y</a>', '<p>só um paragrafo</p>']) {
    assert.equal(looksLikeHtml(s), true);
  }
  for (const s of ['Array<T>', 'a < b', '<div>', '## md', 'texto puro', '']) {
    assert.equal(looksLikeHtml(s), false);
  }
});
