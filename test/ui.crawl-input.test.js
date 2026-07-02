// Regressão do "bleed": o valor digitado no 1º campo do wizard de Coletar NÃO pode vazar para o 2º.
// Causa: o TextInput do @inkjs/ui é não-controlado; sem key=${step} o buffer persistia entre passos.
// Coletar é o 1º item do menu, então navegar é só ENTER (evita depender de setas). Rode com: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { html } from '../src/ui/html.js';
import App from '../src/ui/App.js';

const ENTER = '\r';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('UI: o --since não vaza para o campo de max-pages (regressão do bleed)', async () => {
  const { stdin, lastFrame, unmount } = render(html`<${App} />`);
  await wait(80);

  stdin.write(ENTER); // Menu: "Coletar" é o 1º item -> entra no wizard de crawl
  await wait(60);
  stdin.write(ENTER); // Passo "source": "Todas as fontes" (1º) -> avança p/ "since"
  await wait(60);
  assert.ok((lastFrame() || '').includes('--since'), 'deve mostrar o prompt de --since');

  stdin.write('2025-01-15'); // data VÁLIDA e distinta do placeholder (2026-06-25)
  await wait(40);
  stdin.write(ENTER); // envia -> avança p/ "maxpages"
  await wait(60);

  const frame = lastFrame() || '';
  assert.ok(frame.includes('páginas'), `deve avançar para o campo de max-pages\n${frame}`);
  assert.ok(!frame.includes('2025-01-15'), `a data do 1º campo NÃO pode vazar p/ o 2º campo\n${frame}`);

  unmount();
});
