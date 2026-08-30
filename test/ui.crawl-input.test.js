// Regressão do "bleed": o valor digitado no 1º campo do wizard de Coletar NÃO pode vazar para o 2º.
// Causa: o TextInput do @inkjs/ui é não-controlado; sem key=${step} o buffer persistia entre passos.
// Coletar é o 1º item do menu, então navegar é só ENTER (evita depender de setas). Rode com: npm test.
// A navegação é por POLLING (não waits fixos em ms): um ENTER que chega antes de a tela do passo
// renderizar se perde — ou cai noutro item do menu — e derruba o teste em máquina carregada (flaky).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { html } from '../src/ui/html.js';
import App from '../src/ui/App.js';
import { waitForFrame, typeText } from './helpers/ink.js';

const ENTER = '\r';

test('UI: o --since não vaza para o campo de max-pages (regressão do bleed)', async () => {
  const { stdin, lastFrame, unmount } = render(html`<${App} />`);
  await waitForFrame(lastFrame, (f) => f.includes('Coletar')); // menu pronto

  stdin.write(ENTER); // Menu: "Coletar" é o 1º item -> entra no wizard de crawl
  await waitForFrame(lastFrame, (f) => f.includes('fontes coletar')); // passo "source"
  stdin.write(ENTER); // "todas marcadas" (default) -> avança p/ "since"
  const sinceFrame = await waitForFrame(lastFrame, (f) => f.includes('--since'));
  assert.ok(sinceFrame.includes('--since'), 'deve mostrar o prompt de --since');

  // typeText = caractere a caractere (um write da string inteira faz o TextInput do @inkjs/ui
  // submeter valor vazio/parcial; race real) — data VÁLIDA e distinta do placeholder (2026-06-25).
  await typeText(stdin, '2025-01-15');
  stdin.write(ENTER); // envia -> avança p/ "maxpages"
  const frame = await waitForFrame(lastFrame, (f) => f.includes('páginas'));
  assert.ok(frame.includes('páginas'), `deve avançar para o campo de max-pages\n${frame}`);
  assert.ok(!frame.includes('2025-01-15'), `a data do 1º campo NÃO pode vazar p/ o 2º campo\n${frame}`);

  unmount();
});