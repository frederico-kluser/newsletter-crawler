// asyncPool: limite de concorrência respeitado, ordem dos resultados preservada, erro propaga.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asyncPool } from '../src/lib/pool.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('respeita o limite de concorrência e preserva a ordem', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await asyncPool(2, [50, 10, 30, 5, 20], async (ms, i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await sleep(ms);
    inFlight--;
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3, 4], 'resultados na ordem dos itens, não da conclusão');
  assert.ok(peak <= 2, `pico de concorrência ${peak} <= 2`);
});

test('erro do fn propaga (o fail-open por item é responsabilidade do chamador)', async () => {
  await assert.rejects(
    asyncPool(3, [1, 2, 3], async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    }),
    /boom/,
  );
});

test('lista vazia resolve em []', async () => {
  assert.deepEqual(await asyncPool(4, [], async () => 1), []);
});
