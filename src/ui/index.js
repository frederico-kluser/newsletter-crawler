// Bootstrap da UI Ink + teardown. Import dinâmico de ink/App p/ o caminho CLL não pagar o custo
// do React. Dona do ciclo de vida: ao sair (exit()/Ctrl-C) restaura o sink, fecha browser e DB.
import { setLogSink } from '../util.js';
import { closeBrowser } from '../fetch.js';
import { db } from '../db.js';
import { html } from './html.js';

export async function launchUI() {
  const { render } = await import('ink');
  const { default: App } = await import('./App.js');
  const app = render(html`<${App} />`, { patchConsole: true, exitOnCtrlC: true });
  await app.waitUntilExit(); // resolve no exit() do App OU no Ctrl-C (Ink restaura o terminal)
  setLogSink(null);
  await closeBrowser(); // mata o chromium se um crawl foi abandonado (no-op se já fechado)
  try {
    db.close();
  } catch {
    /* já fechado */
  }
  process.exit(0);
}
