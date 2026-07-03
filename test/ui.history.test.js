// HistoryView (histórico de buscas na TUI): lista navegável, Enter abre (onOpen), `r` re-roda
// (onRerun), `d` apaga o selecionado (onDelete + some da lista), `x` duas vezes limpa tudo,
// Esc/b volta. Componente puro: entradas e efeitos por props (spies, sem DB).
process.env.CRAWLER_LANG = ''; // asserts em PT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';

const { html } = await import('../src/ui/html.js');
const { HistoryView } = await import('../src/ui/HistoryView.js');

const DOWN = '[B';
const ENTER = '\r';
const ESC = '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ENTRIES = [
  {
    id: 11, created_at: '2026-07-03 20:00:00', origin: 'cli', query: 'react server components',
    mode: 'A', scope: { all: true }, stats: { relevant: 4, total: 60 }, spent_usd: 0.12,
  },
  {
    id: 12, created_at: '2026-07-03 21:00:00', origin: 'web', query: 'sqlite wasm',
    mode: 'soft', scope: {}, stats: { relevant: 2, total: 40 }, spent_usd: 0.004,
  },
];

function mount(over = {}) {
  const calls = { open: [], rerun: [], del: [], clear: 0, done: [] };
  const r = render(
    html`<${HistoryView}
      entries=${over.entries ?? ENTRIES}
      onOpen=${(e) => calls.open.push(e.id)}
      onRerun=${(e) => calls.rerun.push(e.id)}
      onDelete=${(id) => calls.del.push(id)}
      onClearAll=${() => calls.clear++}
      onDone=${(v) => calls.done.push(v)}
    />`,
  );
  return { ...r, calls };
}

test('lista mostra consulta, modo, stats e custo', async () => {
  const { lastFrame, unmount } = mount();
  await wait(20);
  const f = lastFrame();
  assert.ok(f.includes('react server components'));
  assert.ok(f.includes('(A)'));
  assert.ok(f.includes('4/60'));
  assert.ok(f.includes('sqlite wasm'));
  assert.ok(f.includes('(soft)'));
  assert.ok(f.includes('2 busca(s) salva(s)'));
  unmount();
});

test('Enter abre a entrada selecionada; ↓ move a seleção', async () => {
  const { stdin, calls, unmount } = mount();
  await wait(20);
  stdin.write(ENTER);
  await wait(20);
  assert.deepEqual(calls.open, [11]);
  stdin.write(DOWN);
  await wait(20);
  stdin.write(ENTER);
  await wait(20);
  assert.deepEqual(calls.open, [11, 12]);
  unmount();
});

test('r re-roda a selecionada', async () => {
  const { stdin, calls, unmount } = mount();
  await wait(20);
  stdin.write('r');
  await wait(20);
  assert.deepEqual(calls.rerun, [11]);
  unmount();
});

test('d apaga a selecionada e ela some da lista', async () => {
  const { stdin, lastFrame, calls, unmount } = mount();
  await wait(20);
  stdin.write('d');
  await wait(20);
  assert.deepEqual(calls.del, [11]);
  assert.ok(!lastFrame().includes('react server components'));
  assert.ok(lastFrame().includes('sqlite wasm'));
  unmount();
});

test('x arma a confirmação e o 2º x limpa tudo (estado vazio)', async () => {
  const { stdin, lastFrame, calls, unmount } = mount();
  await wait(20);
  stdin.write('x');
  await wait(20);
  assert.ok(lastFrame().includes('x de novo'));
  assert.equal(calls.clear, 0); // 1º toque só arma
  stdin.write('x');
  await wait(20);
  assert.equal(calls.clear, 1);
  assert.ok(lastFrame().includes('Nenhuma busca salva'));
  unmount();
});

test('Esc volta ao menu; lista vazia mostra o estado vazio', async () => {
  const { stdin, calls, unmount } = mount();
  await wait(20);
  stdin.write(ESC);
  await wait(20);
  assert.deepEqual(calls.done, ['menu']);
  unmount();

  const empty = mount({ entries: [] });
  await wait(20);
  assert.ok(empty.lastFrame().includes('Nenhuma busca salva'));
  empty.unmount();
});
