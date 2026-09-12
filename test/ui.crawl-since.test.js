// O campo --since VAZIO deixou de ser "o piso mais amplo": com o CURSOR POR FONTE
// (src/cursor.js + sources.cursor_date), vazio = cada fonte repete o piso da própria última
// captura (o item mais novo já capturado) e só cai no derivado/piso mínimo quando ainda não tem
// cursor. O passo dedicado continua existindo para isso ficar DITO antes do wizard seguir — e
// oferece voltar e informar a data (uma coleta de recuperação, mais funda no arquivo, é uma
// decisão consciente).
//
// O texto esperado vem do PRÓPRIO i18n (`t`), com o whitespace normalizado (o ink quebra a frase
// em várias linhas/indenta) — asserção presa à fonte única da verdade, e não a uma paráfrase que
// envelhece sozinha. As checagens semânticas (piso POR FONTE, cursor, fallback do piso mínimo)
// garantem que a string do i18n continua dizendo a coisa certa: sem elas, trocar o dicionário por
// um texto errado passaria.
// NC_HOME temporário ANTES do import (screens.js -> commands.js -> db.js abre o banco no load).
process.env.CRAWLER_LANG = ''; // asserts em PT

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { render } from 'ink-testing-library';
import { keys, wait, waitForFrame, typeText } from './helpers/ink.js';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-ui-since-'));
const { html } = await import('../src/ui/html.js');
const { CrawlConfig } = await import('../src/ui/screens.js');
const { t } = await import('../src/ui/i18n.js');
const { MIN_CRAWL_DATE } = await import('../src/config.js');
const { db } = await import('../src/db.js');

after(() => {
  try {
    db.close();
  } finally {
    rmSync(process.env.NC_HOME, { recursive: true, force: true });
  }
});

/** Texto do frame sem a formatação do ink (quebras/indentação) — comparável com o i18n. */
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const HINT = flat(t('sinceHint', { floor: MIN_CRAWL_DATE }));
const WARN = flat(t('sinceFloorWarn', { floor: MIN_CRAWL_DATE }));
const KEEP = flat(t('sinceFloorKeep', { floor: MIN_CRAWL_DATE }));
/** O passo de aviso já montou? (prefixo do i18n, imune à quebra de linha do ink) */
const warnShown = (f) => flat(f).includes(WARN.slice(0, 40));

/** Monta o wizard do Coletar e avança o passo de fontes (todas marcadas = Enter direto). */
async function openSinceStep() {
  const r = render(html`<${CrawlConfig} onRun=${() => {}} onBack=${() => {}} />`);
  await wait(120);
  r.stdin.write(keys.ENTER); // MultiSelect com tudo marcado -> "todas as fontes"
  await waitForFrame(r.lastFrame, (f) => f.includes('Data-limite'));
  return r;
}

test('T5: o campo --since anuncia que o vazio é o piso POR FONTE (cursor)', async () => {
  const { lastFrame, unmount } = await openSinceStep();
  const f = lastFrame() || '';
  assert.ok(f.includes('Data-limite'), f);
  assert.ok(flat(f).includes(HINT), `o hint do campo é o do i18n (texto exato)\n${f}`);
  assert.ok(/Vazio = piso POR FONTE/.test(f), `o piso do vazio aparece no campo\n${f}`);
  assert.ok(/cursor da última captura/.test(f), `e que ele vem do cursor da fonte\n${f}`);
  assert.ok(f.includes(MIN_CRAWL_DATE), 'o fallback (fonte sem cursor) também aparece');
  assert.ok(!/MAIS AMPLO/.test(f), 'a promessa antiga ("piso mais amplo") não pode voltar');
  unmount();
});

test('T5b: Enter com o campo VAZIO cai no aviso do piso, não direto no próximo passo', async () => {
  const { stdin, lastFrame, unmount } = await openSinceStep();
  stdin.write(keys.ENTER); // submete VAZIO
  const f = await waitForFrame(lastFrame, (x) => warnShown(x));
  assert.ok(warnShown(f), `o aviso do passo tem de estar no frame\n${f}`);
  assert.ok(flat(f).includes(WARN), `o aviso é o do i18n (texto exato)\n${f}`);
  assert.ok(/próprio CURSOR/.test(f), `o aviso explica de onde vem o piso\n${f}`);
  assert.ok(/repete esse piso em vez de varrer de novo/.test(f), `e o que muda na prática\n${f}`);
  assert.ok(f.includes(MIN_CRAWL_DATE), `com o fallback de quem não tem cursor\n${f}`);
  assert.ok(f.includes(t('sinceFloorPick')), `oferece corrigir\n${f}`);
  assert.ok(f.includes(KEEP), `e seguir de propósito\n${f}`);
  assert.ok(!f.includes('Máx. páginas'), `não pode ter pulado para o próximo passo\n${f}`);
  unmount();
});

test('T5c: "Informar uma data" volta ao campo; a data digitada segue o fluxo normal', async () => {
  const { stdin, lastFrame, unmount } = await openSinceStep();
  stdin.write(keys.ENTER); // vazio -> aviso
  await waitForFrame(lastFrame, (x) => warnShown(x));
  stdin.write(keys.ENTER); // 1ª opção: "Informar uma data"
  await waitForFrame(lastFrame, (x) => x.includes('Data-limite'));
  await typeText(stdin, '2026-08-01');
  stdin.write(keys.ENTER);
  const f = await waitForFrame(lastFrame, (x) => x.includes('Máx. páginas'));
  assert.ok(f.includes('Máx. páginas'), `com data, o wizard segue direto\n${f}`);
  unmount();
});

test('T5d: "Seguir sem data" é uma escolha explícita e leva ao próximo passo', async () => {
  const { stdin, lastFrame, unmount } = await openSinceStep();
  stdin.write(keys.ENTER); // vazio -> aviso
  await waitForFrame(lastFrame, (x) => warnShown(x));
  stdin.write(keys.DOWN); // 2ª opção: "Seguir sem data (piso por fonte)"
  await wait(30);
  stdin.write(keys.ENTER);
  const f = await waitForFrame(lastFrame, (x) => x.includes('Máx. páginas'));
  assert.ok(f.includes('Máx. páginas'), f);
  unmount();
});
