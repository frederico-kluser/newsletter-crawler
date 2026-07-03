// RunView (dispatcher): p/ o CRAWL renderiza o CrawlDashboard, assina o fluxo de marcos, roda o
// thunk e ao fim mostra o Alert/Select; a tecla `v` abre o overlay de log cru. P/ os demais comandos
// cai no painel simples (counters + feed cru), sem dashboard. Exercita a assinatura + teardown + input
// sem crawl real (thunk injetado emite marcos direto). getStatus/getRunTelemetry leem o DB (só leitura).
process.env.CRAWLER_LANG = '';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';

const { html } = await import('../src/ui/html.js');
const { RunView } = await import('../src/ui/RunView.js');
const { emitRunEvent, runEventsReset } = await import('../src/run-events.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('UI/RunView crawl: dashboard + marcos ao vivo; v abre o overlay; conclui com navegação', async () => {
  runEventsReset();
  let release;
  const gate = new Promise((r) => (release = r));
  const spec = {
    sub: 'crawl',
    thunk: async () => {
      emitRunEvent({ phase: 'curation', kind: 'issue-curated', source: 'TLDR', detail: '7 itens' });
      await gate; // mantém a "run" aberta p/ inspecionar o painel ativo
    },
  };
  const done = [];
  const { lastFrame, stdin, unmount } = render(
    html`<${RunView} spec=${spec} onDone=${(v) => done.push(v)} onResults=${() => {}} />`,
  );
  await wait(60);
  let frame = lastFrame() || '';
  assert.ok(frame.includes('Coleta'), `dashboard do crawl visível\n${frame}`);
  assert.ok(frame.includes('coletânea curada'), 'marco emitido apareceu no feed');

  stdin.write('v'); // abre overlay verbose
  await wait(40);
  assert.ok(/log bruto/i.test(lastFrame() || ''), 'overlay verbose abriu com v');
  stdin.write('v'); // fecha
  await wait(40);

  release(); // conclui a run
  await wait(80);
  frame = lastFrame() || '';
  assert.ok(/conclu[íi]do/i.test(frame), `badge concluído ao fim\n${frame}`);
  assert.ok(frame.includes('Voltar ao menu'), 'opções de navegação ao fim');
  unmount();
});

test('UI/RunView não-crawl: painel simples (counters), sem dashboard', async () => {
  const spec = { sub: 'classify', thunk: async () => {} };
  const { lastFrame, unmount } = render(
    html`<${RunView} spec=${spec} onDone=${() => {}} onResults=${() => {}} />`,
  );
  await wait(60);
  const frame = lastFrame() || '';
  assert.ok(!frame.includes('◆ Coleta'), 'sem cabeçalho de dashboard no não-crawl');
  assert.ok(/conclu[íi]do/i.test(frame), 'painel simples conclui com Alert');
  assert.ok(frame.includes('artigos'), 'counters do painel simples');
  unmount();
});
