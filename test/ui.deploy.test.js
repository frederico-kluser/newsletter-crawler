// Garante que a interface Ink chega na tela de PUBLICAR e para na revisão do comando. NÃO confirma
// a execução (isso faria export + commit + push + build real). Navegação por LABEL (helpers/ink.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { render } from 'ink-testing-library';
import { wait, selectMenuItem, keys } from './helpers/ink.js';

// NC_HOME temporário ANTES do import (App.js/screens.js -> commands.js -> db.js abre o DB no
// load: com o NC_HOME real, `npm test` abriria o crawler.db do USUÁRIO em ESCRITA). Import
// dinâmico porque o `import` estático é IÇADO — rodaria antes desta linha.
process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-ui-deploy-'));
const { html } = await import('../src/ui/html.js');
const { default: App } = await import('../src/ui/App.js');
const { DeployConfirm } = await import('../src/ui/screens.js');
const { db } = await import('../src/db.js');

after(() => {
  // finally: um close() que lance não pode deixar o diretório temporário para trás.
  try {
    db.close();
  } finally {
    rmSync(process.env.NC_HOME, { recursive: true, force: true });
  }
});

test('UI: o menu leva à tela de publicar, com os 3 modos', async () => {
  const { stdin, lastFrame, unmount } = render(html`<${App} />`);
  await wait(80);
  assert.ok((lastFrame() || '').includes('Publicar'), 'o menu deve oferecer Publicar no site');

  await selectMenuItem(stdin, lastFrame, 'Publicar');
  const frame = lastFrame() || '';
  for (const label of ['Como publicar', 'Republicar', 'Simular']) {
    assert.ok(frame.includes(label), `a tela deve oferecer "${label}"\n--- frame ---\n${frame}`);
  }
  unmount();
});

test('UI: escolher um modo cai na REVISÃO com o comando equivalente (sem executar)', async () => {
  let ran = null;
  const { stdin, lastFrame, unmount } = render(
    html`<${DeployConfirm} onRun=${(spec) => { ran = spec; }} onBack=${() => {}} />`,
  );
  await wait(30);
  stdin.write(keys.ENTER); // 1ª opção: Publicar
  await wait(30);
  const frame = lastFrame() || '';
  assert.ok(frame.includes('npm run deploy'), `deve mostrar o comando equivalente\n${frame}`);
  assert.equal(ran, null, 'a revisão NÃO pode disparar o deploy sozinha');

  stdin.write(keys.ENTER); // confirma na revisão
  await wait(30);
  assert.deepEqual(ran, { sub: 'deploy', flags: {}, rest: [] });
  unmount();
});

test('UI: o modo forçado emite --force no comando revisado', async () => {
  let ran = null;
  const { stdin, lastFrame, unmount } = render(
    html`<${DeployConfirm} onRun=${(spec) => { ran = spec; }} onBack=${() => {}} />`,
  );
  await wait(30);
  stdin.write(keys.DOWN); // desce p/ "Republicar mesmo sem dado novo (--force)"
  await wait(20);
  stdin.write(keys.ENTER);
  await wait(30);
  assert.ok((lastFrame() || '').includes('--force'), 'a revisão deve mostrar --force');

  stdin.write(keys.ENTER);
  await wait(30);
  assert.deepEqual(ran, { sub: 'deploy', flags: { force: true }, rest: [] });
  unmount();
});
