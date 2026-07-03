// SourcesStep (checkbox de fontes do Coletar): todas pré-marcadas (Enter direto = todas → null,
// sem flag); espaço desmarca e o submit vira subconjunto; 0 marcadas → erro inline SEM chamar o
// submit (e re-marcar limpa o erro); Esc volta. NC_HOME temporário ANTES do import (screens.js →
// commands.js → db.js). O preview do comando quota a lista com espaços.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-ui-sources-'));
const { render } = await import('ink-testing-library');
const { html } = await import('../src/ui/html.js');
const { SourcesStep } = await import('../src/ui/screens.js');
const { buildCommandPreview } = await import('../src/ui/commandPreview.js');
const { db } = await import('../src/db.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

const DOWN = '\x1b[B';
const ENTER = '\r';
const ESC = '\x1b';
const SPACE = ' ';
const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const ticks = (frame) => ((frame || '').match(/✔/g) || []).length;

const SOURCES = [
  { name: 'Node Weekly', url: 'https://nodeweekly.com/issues' },
  { name: 'JavaScript Weekly', url: 'https://javascriptweekly.com/issues' },
  { name: 'Golang Weekly', url: 'https://golangweekly.com/issues' },
];

test('todas pré-marcadas; Enter direto submete null (= todas, sem flag)', async () => {
  const calls = [];
  const { stdin, lastFrame, unmount } = render(
    html`<${SourcesStep} sources=${SOURCES} onSubmit=${(v) => calls.push(v)} onBack=${() => {}} />`,
  );
  await wait(80);
  const frame = lastFrame() || '';
  assert.ok(frame.includes('Node Weekly') && frame.includes('Golang Weekly'), `opções visíveis\n${frame}`);
  assert.equal(ticks(frame), SOURCES.length, `todas pré-marcadas\n${frame}`);
  stdin.write(ENTER);
  await wait(60);
  assert.deepEqual(calls, [null]);
  unmount();
});

test('espaço desmarca a focada; Enter submete o subconjunto restante', async () => {
  const calls = [];
  const { stdin, lastFrame, unmount } = render(
    html`<${SourcesStep} sources=${SOURCES} onSubmit=${(v) => calls.push(v)} onBack=${() => {}} />`,
  );
  await wait(80);
  stdin.write(SPACE); // desmarca "Node Weekly" (1ª focada)
  await wait(50);
  assert.equal(ticks(lastFrame()), SOURCES.length - 1);
  stdin.write(ENTER);
  await wait(60);
  assert.deepEqual(calls, [['JavaScript Weekly', 'Golang Weekly']]);
  unmount();
});

test('0 marcadas: Enter mostra o erro e NÃO submete; re-marcar limpa o erro', async () => {
  const calls = [];
  const { stdin, lastFrame, unmount } = render(
    html`<${SourcesStep} sources=${SOURCES} onSubmit=${(v) => calls.push(v)} onBack=${() => {}} />`,
  );
  await wait(80);
  for (let i = 0; i < SOURCES.length; i++) {
    stdin.write(SPACE);
    await wait(40);
    if (i < SOURCES.length - 1) {
      stdin.write(DOWN);
      await wait(40);
    }
  }
  assert.equal(ticks(lastFrame()), 0, `tudo desmarcado\n${lastFrame()}`);
  stdin.write(ENTER);
  await wait(60);
  assert.ok((lastFrame() || '').includes('Marque pelo menos 1'), `erro visível\n${lastFrame()}`);
  assert.equal(calls.length, 0, 'não pode submeter com 0 marcadas');
  stdin.write(SPACE); // re-marca a focada -> onChange limpa o erro
  await wait(60);
  assert.ok(!(lastFrame() || '').includes('Marque pelo menos 1'), `erro limpo\n${lastFrame()}`);
  stdin.write(ENTER);
  await wait(60);
  assert.deepEqual(calls, [['Golang Weekly']]);
  unmount();
});

test('Esc chama onBack (useInput paralelo só de escape)', async () => {
  let back = 0;
  const { stdin, unmount } = render(
    html`<${SourcesStep} sources=${SOURCES} onSubmit=${() => {}} onBack=${() => back++} />`,
  );
  await wait(80);
  stdin.write(ESC);
  await wait(60);
  assert.equal(back, 1);
  unmount();
});

test('sem fontes configuradas: aviso + Voltar (sem MultiSelect vazio)', async () => {
  const { lastFrame, unmount } = render(
    html`<${SourcesStep} sources=${[]} onSubmit=${() => {}} onBack=${() => {}} />`,
  );
  await wait(80);
  assert.ok((lastFrame() || '').includes('Nenhuma fonte configurada'));
  unmount();
});

test('preview do comando quota a lista de fontes com espaços', () => {
  const cmd = buildCommandPreview('crawl', { sources: 'Node Weekly,React Status' });
  assert.ok(cmd.includes('--sources "Node Weekly,React Status"'), cmd);
});
