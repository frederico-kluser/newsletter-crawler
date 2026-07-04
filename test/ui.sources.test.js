// SourcesView (Gerenciar fontes na TUI): lista navegável com trocar tipo (Enter), re-detectar por
// IA (`d`, assíncrono), remover (`r` arma + `r`/Enter confirma) e Esc/b volta. Componente puro:
// entradas e efeitos por props (spies, sem DB). npm test.
process.env.CRAWLER_LANG = ''; // asserts em PT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';

const { html } = await import('../src/ui/html.js');
const { SourcesView } = await import('../src/ui/SourcesView.js');

const DOWN = '[B';
const ENTER = '\r';
const ESC = '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SOURCES = [
  { id: 1, name: 'Node Weekly', base_url: 'https://nodeweekly.com/issues', type: 'index', articles: 120 },
  { id: 2, name: 'My Blog', base_url: 'https://myblog.com/', type: 'listing', articles: 8 },
];

function mount(over = {}) {
  const calls = { toggle: [], redetect: [], remove: [], done: [] };
  const r = render(
    html`<${SourcesView}
      sources=${over.sources ?? SOURCES.map((s) => ({ ...s }))}
      onToggleType=${(s, type) => {
        calls.toggle.push([s.id, type]);
        return { source: { ...s, type } };
      }}
      onRedetect=${(s) => {
        calls.redetect.push(s.id);
        return Promise.resolve({ source: { ...s, type: 'index' }, detection: { type: 'index', reason: 'muitos /issues' } });
      }}
      onRemove=${(s) => {
        calls.remove.push(s.id);
        return { counts: { articles: s.articles } };
      }}
      onDone=${(v) => calls.done.push(v)}
    />`,
  );
  return { ...r, calls };
}

test('lista mostra nome, tipo e a fonte (base_url)', async () => {
  const { lastFrame, unmount } = mount();
  await wait(20);
  const f = lastFrame();
  assert.ok(f.includes('Node Weekly'));
  assert.ok(f.includes('[index]'));
  assert.ok(f.includes('My Blog'));
  assert.ok(f.includes('[listing]'));
  assert.ok(f.includes('nodeweekly.com/issues'));
  assert.ok(f.includes('2 fonte(s)'));
  unmount();
});

test('Enter troca o tipo (index -> listing) e persiste via onToggleType', async () => {
  const { stdin, lastFrame, calls, unmount } = mount();
  await wait(20);
  stdin.write(ENTER);
  await wait(20);
  assert.deepEqual(calls.toggle, [[1, 'listing']]);
  assert.ok(lastFrame().includes('tipo alterado para listing'));
  unmount();
});

test('d re-detecta (assíncrono), chama onRedetect e mostra a nota do resultado', async () => {
  const { stdin, lastFrame, calls, unmount } = mount();
  await wait(20);
  stdin.write(DOWN); // seleciona "My Blog" (listing)
  await wait(20);
  stdin.write('d');
  await wait(60); // aguarda a Promise da detecção resolver
  assert.deepEqual(calls.redetect, [2]);
  assert.ok(lastFrame().includes('re-detectado'));
  assert.ok(lastFrame().includes('muitos /issues'));
  unmount();
});

test('r arma a confirmação e o 2º r remove a fonte (some da lista)', async () => {
  const { stdin, lastFrame, calls, unmount } = mount();
  await wait(20);
  stdin.write('r');
  await wait(20);
  assert.ok(lastFrame().includes('Remover'));
  assert.ok(lastFrame().includes('Node Weekly'));
  assert.equal(calls.remove.length, 0); // 1º toque só arma
  stdin.write('r');
  await wait(20);
  assert.deepEqual(calls.remove, [1]);
  assert.ok(lastFrame().includes('1 fonte(s)')); // era 2, agora 1
  assert.ok(lastFrame().includes('removida'));
  unmount();
});

test('Esc volta ao menu; lista vazia mostra o estado vazio', async () => {
  const { stdin, calls, unmount } = mount();
  await wait(20);
  stdin.write(ESC);
  await wait(20);
  assert.deepEqual(calls.done, ['menu']);
  unmount();

  const empty = mount({ sources: [] });
  await wait(20);
  assert.ok(empty.lastFrame().includes('Nenhuma fonte cadastrada'));
  empty.unmount();
});
