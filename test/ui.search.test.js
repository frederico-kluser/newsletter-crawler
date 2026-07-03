// Garante que a interface Ink permite PESQUISAR: navega menu -> Buscar -> digita a consulta ->
// chega na escolha de modo (A/B). Não dispara a busca (sem LLM) — só valida o caminho da UI.
// Navegação por LABEL (helpers/ink.js): imune a reordenação do menu. Rode com: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { html } from '../src/ui/html.js';
import App from '../src/ui/App.js';
import { keys, wait, selectMenuItem } from './helpers/ink.js';

test('UI: dá para chegar na busca pelo menu (Buscar -> consulta -> modo)', async () => {
  const { stdin, lastFrame, unmount } = render(html`<${App} />`);
  await wait(80);
  assert.ok((lastFrame() || '').includes('Buscar'), 'o menu deve oferecer Buscar');

  await selectMenuItem(stdin, lastFrame, 'Buscar');
  assert.ok((lastFrame() || '').includes('buscar'), 'deve abrir o prompt da consulta');

  // Digita a consulta e envia -> passo de escopo (novo vs. acervo).
  stdin.write('react server components');
  await wait(40);
  stdin.write(keys.ENTER);
  await wait(80);
  assert.ok((lastFrame() || '').includes('trazer'), 'deve mostrar o passo de escopo (novo vs. acervo)');

  // Escopo: "Apenas o novo" (1º) -> avança p/ a escolha de modo.
  stdin.write(keys.ENTER);
  await wait(80);
  const frame = lastFrame() || '';
  assert.ok(frame.includes('Modo A') && frame.includes('Modo B'), `deve oferecer os 2 modos\n${frame}`);

  unmount();
});
