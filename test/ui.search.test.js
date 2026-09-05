// Garante que a interface Ink permite PESQUISAR: navega menu -> Buscar -> digita a consulta ->
// chega na escolha de modo (A/B). Não dispara a busca (sem LLM) — só valida o caminho da UI.
// Navegação por LABEL (helpers/ink.js): imune a reordenação do menu. Rode com: npm test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { render } from 'ink-testing-library';
import { keys, selectMenuItem, typeText, waitForFrame } from './helpers/ink.js';

// NC_HOME temporário ANTES do import (App.js -> commands.js -> db.js abre o DB no load: com o
// NC_HOME real, `npm test` abriria o crawler.db do USUÁRIO em ESCRITA). Import dinâmico porque o
// `import` estático é IÇADO — rodaria antes desta linha.
process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-ui-search-'));
const { html } = await import('../src/ui/html.js');
const { default: App } = await import('../src/ui/App.js');
const { db } = await import('../src/db.js');

after(() => {
  // finally: um close() que lance não pode deixar o diretório temporário para trás.
  try {
    db.close();
  } finally {
    rmSync(process.env.NC_HOME, { recursive: true, force: true });
  }
});

test('UI: dá para chegar na busca pelo menu (Buscar -> consulta -> modo)', async () => {
  const { stdin, lastFrame, unmount } = render(html`<${App} />`);
  // Polling em vez de esperas fixas em ms: transições de tela levam >1 frame em máquina carregada.
  await waitForFrame(lastFrame, (f) => f.includes('Buscar'));
  assert.ok((lastFrame() || '').includes('Buscar'), 'o menu deve oferecer Buscar');

  await selectMenuItem(stdin, lastFrame, 'Buscar');
  await waitForFrame(lastFrame, (f) => f.includes('buscar'));
  assert.ok((lastFrame() || '').includes('buscar'), 'deve abrir o prompt da consulta');

  // Digita a consulta e envia -> passo de escopo (novo vs. acervo). typeText = caractere a
  // caractere (um write da string inteira faz o submit ler valor vazio; race do @inkjs/ui).
  await typeText(stdin, 'react server components');
  stdin.write(keys.ENTER);
  await waitForFrame(lastFrame, (f) => f.includes('trazer'));
  assert.ok((lastFrame() || '').includes('trazer'), 'deve mostrar o passo de escopo (novo vs. acervo)');

  // Escopo: "Apenas o novo" (1º) -> avança p/ a escolha de modo (o waitForFrame já assenta o
  // tempo de registro do Select recém-montado — um ENTER imediato após o frame se perderia).
  stdin.write(keys.ENTER);
  const frame = await waitForFrame(lastFrame, (f) => f.includes('Modo A') && f.includes('Modo B'));
  assert.ok(frame.includes('Modo A') && frame.includes('Modo B'), `deve oferecer os 2 modos\n${frame}`);

  unmount();
});
