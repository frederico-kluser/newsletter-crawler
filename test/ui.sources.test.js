// SourcesView (Gerenciar fontes na TUI): lista navegável com trocar tipo (Enter), re-detectar por
// IA (`d`, assíncrono), remover (`r` abre a confirmação DIGITADA) e Esc/b volta. Componente puro:
// entradas e efeitos por props (spies, sem DB). npm test.
//
// A remoção apaga TODO o acervo da fonte: `r` `r` (dois toques, zero digitação) era fricção de
// menos para isso. Agora `r` pede o NÚMERO de artigos da fonte — o mesmo desafio do reset; só a
// fonte SEM artigo nenhum segue no Enter seco (não há o que perder nela).
process.env.CRAWLER_LANG = ''; // asserts em PT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { typeText, waitForFrame } from './helpers/ink.js';

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
      confirmCheck=${over.confirmCheck}
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

test('r NÃO basta mais: pede o nº de artigos, recusa o errado e some com o certo', async () => {
  const { stdin, lastFrame, calls, unmount } = mount();
  await wait(20);
  stdin.write('r');
  const armed = await waitForFrame(lastFrame, (f) => f.includes('digite o número'));
  assert.ok(armed.includes('Remover'));
  assert.ok(armed.includes('Node Weekly'));
  assert.ok(/\(120\)/.test(armed), `o desafio mostra os 120 artigos em jogo\n${armed}`);

  stdin.write('r'); // o gesto ANTIGO (2º r) agora é só um caractere no campo
  await wait(40);
  assert.equal(calls.remove.length, 0, 'r r não pode mais remover');
  stdin.write('\r'); // e o Enter com "r" digitado é RECUSADO
  const bad = await waitForFrame(lastFrame, (f) => f.includes('NÃO confere'));
  assert.equal(calls.remove.length, 0, 'valor errado não remove');
  assert.ok(bad.includes('NÃO confere'));

  // A tentativa recusada LIMPA o campo (o TextInput é uncontrolled: sem remontar, digitar "120"
  // em cima do "r" viraria "r120" e o usuário nunca acertaria).
  await typeText(stdin, '120');
  stdin.write('\r');
  await waitForFrame(lastFrame, (f) => f.includes('removida'));
  assert.deepEqual(calls.remove, [1], 'a 2ª tentativa, certa, remove');
  unmount();

  // ---- número certo ----
  const ok = mount();
  await wait(20);
  ok.stdin.write('r');
  await waitForFrame(ok.lastFrame, (f) => f.includes('digite o número'));
  await typeText(ok.stdin, '120');
  ok.stdin.write('\r');
  await waitForFrame(ok.lastFrame, (f) => f.includes('removida'));
  assert.deepEqual(ok.calls.remove, [1]);
  assert.ok(ok.lastFrame().includes('1 fonte(s)')); // era 2, agora 1
  ok.unmount();
});

test('fonte SEM artigos segue no Enter seco (nada a perder)', async () => {
  const { stdin, lastFrame, calls, unmount } = mount({
    sources: [{ id: 9, name: 'Vazia', base_url: 'https://vazia.test/', type: 'listing', articles: 0 }],
  });
  await wait(20);
  stdin.write('r');
  await waitForFrame(lastFrame, (f) => f.includes('Enter confirma'));
  assert.ok(lastFrame().includes('não tem artigo nenhum'));
  stdin.write(ENTER);
  await wait(40);
  assert.deepEqual(calls.remove, [9]);
  unmount();
});

test('o desafio usa o confirmCheck injetado (o MESMO do reset)', async () => {
  const seen = [];
  const { stdin, lastFrame, calls, unmount } = mount({
    confirmCheck: (answer, n) => {
      seen.push([answer, n]);
      return { ok: String(answer).replace(/[.\s]/g, '') === String(n), given: answer, expected: String(n) };
    },
  });
  await wait(20);
  stdin.write('r');
  await waitForFrame(lastFrame, (f) => f.includes('digite o número'));
  await typeText(stdin, '1.20'); // separador de milhar é aceito pelo cheque do reset
  stdin.write('\r');
  await waitForFrame(lastFrame, (f) => f.includes('removida'));
  assert.deepEqual(seen, [['1.20', 120]]);
  assert.deepEqual(calls.remove, [1]);
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
