// O campo --since VAZIO não é "sem mudança": o piso cai para MIN_CRAWL_DATE (2026-01-01), que
// costuma ser MAIS AMPLO que o --since da coleta anterior — o walk desce mais fundo no arquivo e a
// curadoria por IA roda em issues antigas (tempo e US$). A tela mostrava o piso, mas não avisava
// que ele é o mais amplo; agora um passo dedicado diz isso e oferece voltar e informar a data.
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
const { db } = await import('../src/db.js');

after(() => {
  try {
    db.close();
  } finally {
    rmSync(process.env.NC_HOME, { recursive: true, force: true });
  }
});

/** Monta o wizard do Coletar e avança o passo de fontes (todas marcadas = Enter direto). */
async function openSinceStep() {
  const r = render(html`<${CrawlConfig} onRun=${() => {}} onBack=${() => {}} />`);
  await wait(120);
  r.stdin.write(keys.ENTER); // MultiSelect com tudo marcado -> "todas as fontes"
  await waitForFrame(r.lastFrame, (f) => f.includes('Data-limite'));
  return r;
}

test('T5: o campo --since anuncia que o vazio é o piso MAIS AMPLO', async () => {
  const { lastFrame, unmount } = await openSinceStep();
  const f = lastFrame() || '';
  assert.ok(f.includes('Data-limite'), f);
  assert.ok(/Vazio = piso 2026-01-01/.test(f), `o piso do vazio aparece no campo\n${f}`);
  assert.ok(/MAIS AMPLO/.test(f), `e que ele é o mais amplo possível\n${f}`);
  unmount();
});

test('T5b: Enter com o campo VAZIO cai no aviso do piso, não direto no próximo passo', async () => {
  const { stdin, lastFrame, unmount } = await openSinceStep();
  stdin.write(keys.ENTER); // submete VAZIO
  const f = await waitForFrame(lastFrame, (x) => x.includes('Sem data, o piso vira'));
  assert.ok(f.includes('2026-01-01'), f);
  assert.ok(/MAIS AMPLO/.test(f), `o aviso explica o que muda\n${f}`);
  assert.ok(/cura issues antigas por IA/.test(f), `e o custo disso\n${f}`);
  assert.ok(f.includes('Informar uma data'), `oferece corrigir\n${f}`);
  assert.ok(f.includes('Seguir sem data'), `e seguir de propósito\n${f}`);
  assert.ok(!f.includes('Máx. páginas'), `não pode ter pulado para o próximo passo\n${f}`);
  unmount();
});

test('T5c: "Informar uma data" volta ao campo; a data digitada segue o fluxo normal', async () => {
  const { stdin, lastFrame, unmount } = await openSinceStep();
  stdin.write(keys.ENTER); // vazio -> aviso
  await waitForFrame(lastFrame, (x) => x.includes('Sem data, o piso vira'));
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
  await waitForFrame(lastFrame, (x) => x.includes('Sem data, o piso vira'));
  stdin.write(keys.DOWN); // 2ª opção: "Seguir sem data (piso 2026-01-01)"
  await wait(30);
  stdin.write(keys.ENTER);
  const f = await waitForFrame(lastFrame, (x) => x.includes('Máx. páginas'));
  assert.ok(f.includes('Máx. páginas'), f);
  unmount();
});
