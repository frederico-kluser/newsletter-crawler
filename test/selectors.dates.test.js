// Pareamento link->data da listagem (parada por --since): <time datetime> (aiweekly),
// [class*="date"] no container (nodeweekly: <span class="issue-date">) e regex estrita no
// texto do item. NC_HOME temporário ANTES do import (selectors.js importa db.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-seldates-'));
const { applyLinkSelectorWithDates } = await import('../src/selectors.js');
const { db } = await import('../src/db.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

const BASE = 'https://ex.com/issues';

test('time[datetime] descendente do link (layout aiweekly) segue funcionando', () => {
  const html = `<ul>
    <li><a href="/issues/2"><time datetime="2026-06-25">Jun 25</time> Ed. 2</a></li>
    <li><a href="/issues/1"><time datetime="2026-06-18">Jun 18</time> Ed. 1</a></li>
  </ul>`;
  const out = applyLinkSelectorWithDates(html, 'li a', 'href', BASE);
  assert.deepEqual(out.map((o) => o.date), ['2026-06-25', '2026-06-18']);
});

test('span[class*=date] no container do item (layout nodeweekly)', () => {
  const html = `<div class="issues">
    <div class="issue-card"><span class="issue-ref">#631</span>
      <span class="issue-subject"><a href="/issues/631">CLI best practices</a></span>
      <span class="issue-date">2026-07-02</span></div>
    <div class="issue-card"><span class="issue-ref">#628</span>
      <span class="issue-subject"><a href="/issues/628">Older</a></span>
      <span class="issue-date">2026-06-11</span></div>
  </div>`;
  const out = applyLinkSelectorWithDates(html, '.issue-subject a', 'href', BASE);
  assert.deepEqual(out.map((o) => o.date), ['2026-07-02', '2026-06-11']);
});

test('regex estrita no texto curto do item ("June 18, 2026"), sem classe de data', () => {
  const html = `<ul><li><a href="/i/9">Ed. 9</a> — June 18, 2026</li></ul>`;
  const out = applyLinkSelectorWithDates(html, 'li a', 'href', BASE);
  assert.equal(out[0].date, 'June 18, 2026');
});

test('spec por IA: CSS + atributo, CSS + regex no texto, e regex-only no container', () => {
  const html = `<ul>
    <li class="it"><a href="/i/1">Ed 1</a><span class="quando" data-pub="2026-06-25">quarta</span></li>
    <li class="it"><a href="/i/2">Ed 2</a><span class="quando">publicado em 2026-06-18 às 9h</span></li>
  </ul>`;
  const byAttr = applyLinkSelectorWithDates(html, 'li a', 'href', BASE, {
    date_selector: '.quando', date_attribute: 'data-pub', date_regex: null,
  });
  assert.equal(byAttr[0].date, '2026-06-25');
  const byRegex = applyLinkSelectorWithDates(html, 'li a', 'href', BASE, {
    date_selector: '.quando', date_attribute: null, date_regex: '(\\d{4}-\\d{2}-\\d{2})',
  });
  assert.equal(byRegex[1].date, '2026-06-18');
  const regexOnly = applyLinkSelectorWithDates(html, 'li a', 'href', BASE, {
    date_selector: null, date_attribute: null, date_regex: 'em (\\d{4}-\\d{2}-\\d{2})',
  });
  assert.equal(regexOnly[1].date, '2026-06-18');
});

test('spec ruim degrada p/ fallback genérico (nunca inventa): regex/CSS inválidos', () => {
  const html = `<div class="issues"><div class="issue-card">
    <span class="issue-subject"><a href="/issues/7">Ed 7</a></span>
    <span class="issue-date">2026-06-11</span></div></div>`;
  const badRegex = applyLinkSelectorWithDates(html, '.issue-subject a', 'href', BASE, {
    date_selector: null, date_attribute: null, date_regex: '([0-9', // regex inválida
  });
  assert.equal(badRegex[0].date, '2026-06-11', 'cai no fallback [class*=date]');
  const badCss = applyLinkSelectorWithDates(html, '.issue-subject a', 'href', BASE, {
    date_selector: ':::nope', date_attribute: null, date_regex: null,
  });
  assert.equal(badCss[0].date, '2026-06-11', 'seletor inválido não derruba o parse');
});

test('não inventa data: número solto, classe enganosa e container longo dão null', () => {
  const longTxt = 'x'.repeat(301);
  const html = `<ul>
    <li><a href="/i/1">Issue 631</a> tem 631 leitores</li>
    <li><a href="/i/2">Ed.</a><span class="update-candidates">Update your subscription</span></li>
    <li><a href="/i/3">Ed. longa</a> ${longTxt} 2026-01-01</li>
  </ul>`;
  const out = applyLinkSelectorWithDates(html, 'li a', 'href', BASE);
  assert.deepEqual(out.map((o) => o.date), [null, null, null]);
});
