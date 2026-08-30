// Testes do loader do snapshot (webapp/src/lib/data.js): contents fatiado em partes
// (contents.partN.json) — localização da parte de um id via meta.contentsParts (pura, sem
// fetch) e o getContent lazy POR PARTE (baixa só a parte certa, cacheada, e é fail-open p/
// snapshot antigo sem contentsParts). Sem rede: fetch global é stubado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPartForId, getContent } from '../src/lib/data.js';

test('findPartForId: localiza a parte cujo intervalo from..to contém o id', () => {
  const parts = [
    { file: 'contents.part0.json', from: 1, to: 100 },
    { file: 'contents.part1.json', from: 101, to: 250 },
    { file: 'contents.part2.json', from: 251, to: 400 },
  ];
  assert.equal(findPartForId(parts, 1).file, 'contents.part0.json'); // borda inferior inclusiva
  assert.equal(findPartForId(parts, 100).file, 'contents.part0.json'); // borda superior inclusiva
  assert.equal(findPartForId(parts, 101).file, 'contents.part1.json');
  assert.equal(findPartForId(parts, 250).file, 'contents.part1.json');
  assert.equal(findPartForId(parts, 399).file, 'contents.part2.json');
  assert.equal(findPartForId(parts, 0), null); // abaixo do primeiro from
  assert.equal(findPartForId(parts, 401), null); // acima do último to
  assert.equal(findPartForId([], 5), null); // snapshot sem contents
  // id pode chegar como string (coerção numérica): mesmo intervalo vale
  assert.equal(findPartForId(parts, '101').file, 'contents.part1.json');
});

// Substitui o fetch global por um mapa de arquivos; devolve o map usado (contagem por URL).
function stubFetch(files) {
  const requested = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    requested.push(String(u));
    const body = files[String(u)];
    return body === undefined
      ? { ok: false, status: 404, json: async () => { throw new Error('não chega'); } }
      : { ok: true, status: 200, json: async () => body };
  };
  return {
    requested,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

test('getContent: baixa SÓ a parte que contém o id, cacheada por parte, e devolve o corpo', async () => {
  const parts = [
    { file: 'contents.part0.json', from: 1, to: 100 },
    { file: 'contents.part1.json', from: 101, to: 250 },
  ];
  const files = {
    '/data/meta.json': { generatedAt: 'x', contentsParts: parts },
    '/data/contents.part0.json': { '1': 'corpo a', '42': 'corpo b' },
    '/data/contents.part1.json': { '101': 'corpo c' },
  };
  const fake = stubFetch(files);
  try {
    assert.equal(await getContent(42), 'corpo b'); // part0 vira cache
    assert.equal(await getContent(101), 'corpo c'); // só a part1 foi baixada agora
    assert.equal(await getContent(1), 'corpo a'); // part0 já cacheada: nenhum fetch novo
    assert.equal(await getContent(999), ''); // id fora do snapshot: fail-open, sem fetch
    const contentsFetches = fake.requested.filter((u) => u.includes('contents.')).sort();
    assert.deepEqual(contentsFetches, ['/data/contents.part0.json', '/data/contents.part1.json']);
    // NUNCA baixa "todas as partes": o único arquivo de contents pedido foi a parte certa.
    assert.ok(
      fake.requested.every((u) => !u.includes('contents.part2') && !u.includes('contents.json')),
      'nenhum contents.json único nem parte inexistente é pedido',
    );
    assert.equal(fake.requested.filter((u) => u.endsWith('/data/meta.json')).length, 1); // memo do meta
  } finally {
    fake.restore();
  }
});

test('getContent: snapshot antigo SEM contentsParts => corpo vazio (fail-open)', async () => {
  const fake = stubFetch({ '/data/meta.json': { generatedAt: 'x' } }); // meta pré-partição
  try {
    assert.equal(await getContent(7), '');
    assert.ok(fake.requested.every((u) => !u.includes('contents.')), 'nenhuma parte é pedida');
  } finally {
    fake.restore();
  }
});