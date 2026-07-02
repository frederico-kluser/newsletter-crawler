// Garante que a interface Ink chega no BUSCADOR WEB: menu -> Buscador web -> prompt da porta.
// NÃO avança além do prompt (avançar montaria WebRun e subiria um servidor real).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { html } from '../src/ui/html.js';
import App from '../src/ui/App.js';

const DOWN = '[B';
const ENTER = '\r';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('UI: dá para chegar no buscador web pelo menu (prompt da porta)', async () => {
  const { stdin, lastFrame, unmount } = render(html`<${App} />`);
  await wait(80);
  assert.ok((lastFrame() || '').includes('Buscador web'), 'o menu deve oferecer o Buscador web');

  // Menu: Coletar(0) -> Buscar(1) -> Buscador web(2). Desce 2 e seleciona.
  stdin.write(DOWN);
  await wait(40);
  stdin.write(DOWN);
  await wait(40);
  stdin.write(ENTER);
  await wait(80);
  const frame = lastFrame() || '';
  assert.ok(frame.includes('Porta do servidor'), `deve abrir o prompt da porta\n${frame}`);

  unmount();
});
