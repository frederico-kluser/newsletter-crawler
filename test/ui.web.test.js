// Garante que a interface Ink chega no BUSCADOR WEB: menu -> Buscador web -> prompt da porta.
// NÃO avança além do prompt (avançar montaria WebRun e subiria um servidor real).
// Navegação por LABEL (helpers/ink.js): imune a reordenação do menu.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { render } from 'ink-testing-library';
import { wait, selectMenuItem } from './helpers/ink.js';

// NC_HOME temporário ANTES do import (App.js -> commands.js -> db.js abre o DB no load: com o
// NC_HOME real, `npm test` abriria o crawler.db do USUÁRIO em ESCRITA). Import dinâmico porque o
// `import` estático é IÇADO — rodaria antes desta linha.
process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-ui-web-'));
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

test('UI: dá para chegar no buscador web pelo menu (prompt da porta)', async () => {
  const { stdin, lastFrame, unmount } = render(html`<${App} />`);
  await wait(80);
  assert.ok((lastFrame() || '').includes('Buscador web'), 'o menu deve oferecer o Buscador web');

  await selectMenuItem(stdin, lastFrame, 'Buscador web');
  const frame = lastFrame() || '';
  assert.ok(frame.includes('Porta do servidor'), `deve abrir o prompt da porta\n${frame}`);

  unmount();
});
