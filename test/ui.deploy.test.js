// Garante que a interface Ink chega na tela de PUBLICAR e para na revisão do comando. NÃO confirma
// a execução (isso faria export + commit + push + build real). Navegação por LABEL (helpers/ink.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { html } from '../src/ui/html.js';
import App from '../src/ui/App.js';
import { wait, selectMenuItem, keys } from './helpers/ink.js';
import { DeployConfirm } from '../src/ui/screens.js';

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
