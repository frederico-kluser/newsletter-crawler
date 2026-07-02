// ResultsView navegável: seleção com ↑/↓, Enter abre a PREVIEW (conteúdo completo via
// getArticle injetado), `o` abre o link (onOpen injetado — spy, sem xdg-open de verdade),
// Esc/b volta, q sai. O componente é puro (sem DB/LLM): monta direto com um result fake.
process.env.CRAWLER_LANG = ''; // asserts em PT (i18n resolve o idioma no import)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';

const { html } = await import('../src/ui/html.js');
const { ResultsView, wrapPlainText } = await import('../src/ui/ResultsView.js');

const DOWN = '[B';
const ENTER = '\r';
const ESC = '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const fakeResult = {
  query: 'ia local', mode: 'A', scanned: 3, total: 3, relevant: 3,
  buckets: {
    noticias: [
      {
        id: 1, url: 'https://ex.com/a', title: 'Alpha', title_pt: 'Alfa', summary_pt: 'resumo alfa',
        snippet: '', relation: 'direct', kind: 'news', source_name: 'Ex Weekly', date_iso: '2026-06-30',
      },
      {
        id: 2, url: 'https://ex.com/b', title: 'Beta', title_pt: 'Beta PT', summary_pt: 'resumo beta',
        snippet: '', relation: 'similar', kind: 'news', source_name: 'Ex Weekly', date_iso: '2026-06-29',
      },
    ],
    ferramentas: [
      {
        id: 3, url: 'https://ex.com/c', title: 'Gamma CLI', title_pt: null, summary_pt: null,
        snippet: 'uma cli de teste', relation: 'direct', kind: 'tool', source_name: null, date_iso: null,
      },
    ],
  },
};

function mount({ result = fakeResult, getArticle, onOpen, onDone } = {}) {
  const opened = [];
  const done = [];
  const askedIds = [];
  const ga = getArticle
    ?? ((id) => {
      askedIds.push(id);
      return {
        id, url: `https://ex.com/${id === 1 ? 'a' : id === 2 ? 'b' : 'c'}`,
        title: 'Beta', content: 'corpo completo do artigo. '.repeat(40),
        source_name: 'Ex Weekly', extracted_at: '2026-06-29 10:00:00',
      };
    });
  const r = render(html`<${ResultsView}
    result=${result}
    getArticle=${ga}
    onOpen=${onOpen ?? ((url) => opened.push(url))}
    onDone=${onDone ?? ((v) => done.push(v))}
  />`);
  return { ...r, opened, done, askedIds };
}

test('UI/results: lista com seleção, fonte·data por item e cabeçalhos de seção', async () => {
  const { lastFrame, unmount } = mount();
  await wait(40);
  const frame = lastFrame() || '';
  assert.ok(frame.includes('— Notícias (2) —'), `cabeçalho de notícias\n${frame}`);
  assert.ok(frame.includes('— Ferramentas (1) —'), 'cabeçalho de ferramentas');
  assert.ok(frame.includes('❯ [direct] Alfa'), 'primeiro item selecionado com ponteiro');
  assert.ok(frame.includes('Ex Weekly · 2026-06-30'), 'meta fonte · data visível');
  assert.ok(frame.includes('Enter abre'), 'hint da lista');
  unmount();
});

test('UI/results: ↑/↓ movem a seleção; Enter abre a preview com conteúdo e URL; o abre o link; Esc volta', async () => {
  const { stdin, lastFrame, unmount, opened, askedIds } = mount();
  await wait(40);

  stdin.write(DOWN);
  await wait(40);
  assert.ok((lastFrame() || '').includes('❯ [similar] Beta PT'), 'seleção desceu para o 2º item');

  stdin.write(ENTER);
  await wait(60);
  let frame = lastFrame() || '';
  assert.deepEqual(askedIds, [2], 'preview buscou o artigo completo pelo id certo');
  assert.ok(frame.includes('Beta PT'), 'título na preview');
  assert.ok(frame.includes('https://ex.com/b'), 'URL na preview');
  assert.ok(frame.includes('corpo completo do artigo'), 'conteúdo completo no corpo');
  assert.ok(frame.includes('abre no navegador'), 'hint da preview');

  stdin.write('o');
  await wait(40);
  assert.deepEqual(opened, ['https://ex.com/b'], '`o` abre o link do item');

  stdin.write(ESC);
  await wait(60);
  frame = lastFrame() || '';
  assert.ok(frame.includes('— Notícias (2) —'), 'Esc volta para a lista');
  assert.ok(frame.includes('Enter abre'), 'hint da lista de volta');
  unmount();
});

test('UI/results: id sumido do banco não quebra — preview cai nos dados da busca com aviso', async () => {
  const { stdin, lastFrame, unmount } = mount({ getArticle: () => null });
  await wait(40);
  stdin.write(ENTER);
  await wait(60);
  const frame = lastFrame() || '';
  assert.ok(frame.includes('não está mais no banco'), `aviso de fallback\n${frame}`);
  assert.ok(frame.includes('https://ex.com/a'), 'URL do item da busca continua disponível');
  assert.ok(frame.includes('resumo alfa'), 'corpo cai no resumo da busca');
  unmount();
});

test('UI/results: b volta ao menu, q sai (lista e preview)', async () => {
  const { stdin, unmount, done } = mount();
  await wait(40);
  stdin.write('b');
  await wait(40);
  assert.deepEqual(done, ['menu']);
  stdin.write(ENTER); // abre preview
  await wait(40);
  stdin.write('q');
  await wait(40);
  assert.deepEqual(done, ['menu', 'quit']);
  unmount();
});

test('UI/results: sem resultados mostra o vazio com hint reduzido', async () => {
  const { lastFrame, unmount } = mount({
    result: { query: 'nada', mode: 'B', total: 0, relevant: 0, buckets: { noticias: [], ferramentas: [] } },
  });
  await wait(40);
  const frame = lastFrame() || '';
  assert.ok(frame.includes('Nada encontrado.'), 'estado vazio');
  assert.ok(frame.includes('b volta · q sai'), 'hint do vazio');
  unmount();
});

test('wrapPlainText: respeita a largura, separa parágrafos e corta palavra gigante', () => {
  const lines = wrapPlainText('primeira linha do texto\n\nsegundo parágrafo aqui', 12);
  assert.ok(lines.every((l) => l.length <= 12), `nenhuma linha > 12: ${JSON.stringify(lines)}`);
  assert.ok(lines.includes(''), 'parágrafo duplo vira linha em branco');
  const dura = wrapPlainText('palavracomcinquentaecincocaracteresbemgrandesemespaco', 10);
  assert.ok(dura.every((l) => l.length <= 10), 'corte duro de palavra maior que a largura');
  assert.deepEqual(wrapPlainText('', 10), []);
});
