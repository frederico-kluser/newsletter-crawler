// Concorrência adaptativa: a lane AIMD (corta ½ no 429, recupera +1/10s) e a adaptivePool
// (ordem preservada, largura acompanha getLimit ao vivo, erro propaga, signal aborta).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureLane, noteRateLimit, currentLimit, laneState } from '../src/lib/lane.js';
import { adaptivePool } from '../src/lib/pool.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('lane AIMD: começa no teto, corta pela metade no 429 (piso) e recupera +1 por 10s', () => {
  configureLane({ ceil: 8, floor: 2 });
  assert.equal(currentLimit(0), 8, 'começa OTIMISTA no teto');
  noteRateLimit(1000); // 8 -> 4
  assert.equal(laneState().limit, 4);
  noteRateLimit(1000); // 4 -> 2
  assert.equal(laneState().limit, 2);
  noteRateLimit(1000); // piso: continua 2
  assert.equal(laneState().limit, 2, 'não desce abaixo do piso');
  assert.equal(currentLimit(5000), 2, 'dentro dos 10s do último 429 não cresce');
  assert.equal(currentLimit(11001), 3, '+1 depois de 10s limpos');
  assert.equal(currentLimit(11500), 3, 'só 0,5s desde o último grow: não cresce');
  assert.equal(currentLimit(21002), 4, '+1 na próxima janela de 10s');
});

test('lane AIMD: nunca cresce acima do teto', () => {
  configureLane({ ceil: 3, floor: 1 });
  assert.equal(currentLimit(0), 3);
  assert.equal(currentLimit(10_000_000), 3, 'teto respeitado mesmo sem 429');
});

test('lane AIMD: piso é limitado ao teto', () => {
  configureLane({ ceil: 2, floor: 9 });
  assert.equal(laneState().ceil, 2);
  assert.equal(laneState().floor, 2, 'floor clampado ao ceil');
});

test('adaptivePool: preserva a ordem e respeita o limite (peak <= limit)', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await adaptivePool(
    [50, 10, 30, 5, 20],
    async (ms, i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(ms);
      inFlight--;
      return i;
    },
    { getLimit: () => 2 },
  );
  assert.deepEqual(out, [0, 1, 2, 3, 4], 'resultados na ordem dos itens');
  assert.ok(peak <= 2, `pico ${peak} <= 2`);
});

test('adaptivePool: a largura efetiva cresce quando getLimit aumenta AO VIVO', async () => {
  let limit = 1;
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 6 }, (_, i) => i);
  const p = adaptivePool(
    items,
    async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(20);
      inFlight--;
      return i;
    },
    { getLimit: () => limit },
  );
  await sleep(5); // 1 em voo (lane fechada)
  limit = 3; // abre a lane: os próximos workers entram
  const out = await p;
  assert.deepEqual(out, items);
  assert.ok(peak >= 2, `pico ${peak} deve subir depois que a lane abriu`);
});

test('adaptivePool: erro do fn propaga (fail-open por item fica no chamador)', async () => {
  await assert.rejects(
    adaptivePool(
      [1, 2, 3],
      async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      },
      { getLimit: () => 2 },
    ),
    /boom/,
  );
});

test('adaptivePool: lista vazia resolve []', async () => {
  assert.deepEqual(await adaptivePool([], async () => 1, { getLimit: () => 4 }), []);
});

test('adaptivePool: signal aborta o pool', async () => {
  const ac = new AbortController();
  const items = Array.from({ length: 10 }, (_, i) => i);
  const p = adaptivePool(items, async (i) => {
    await sleep(30);
    return i;
  }, { getLimit: () => 2, signal: ac.signal });
  setTimeout(() => ac.abort(), 5);
  await assert.rejects(p, (e) => e?.name === 'AbortError');
});
