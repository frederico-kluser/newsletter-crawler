// Garante que a interface Ink permite PESQUISAR: navega menu -> Buscar -> digita a consulta ->
// chega na escolha de modo (A/B). Não dispara a busca (sem LLM) — só valida o caminho da UI.
// Navegação por LABEL (helpers/ink.js): imune a reordenação do menu. Rode com: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { html } from '../src/ui/html.js';
import App from '../src/ui/App.js';
import { keys, selectMenuItem, typeText, waitForFrame } from './helpers/ink.js';

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
