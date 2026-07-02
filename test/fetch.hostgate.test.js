// Politeness por host (fetch.js createHostGate): gap inter-request SERIALIZADO por host —
// reserva de timeline — honrando o crawl-delay do robots (cap 30s) e no mínimo o jitter de
// REQUEST_DELAY_MS. Clock/sleep injetados: os waits pedidos são inspecionados, não dormidos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostGate } from '../src/fetch.js';

function mk({ baseDelayMs = 1000 } = {}) {
  const clock = { t: 0 };
  const waits = [];
  const gate = createHostGate({
    now: () => clock.t,
    wait: async (ms) => {
      waits.push(ms);
      clock.t += ms; // dormir avança o clock (modelo síncrono do teste)
    },
    baseDelayMs,
    random: () => 0.5, // jitter determinístico: gap mínimo = baseDelayMs
  });
  return { clock, waits, gate };
}

test('hostgate: primeiro request passa sem espera; o segundo espera o gap', async () => {
  const { waits, gate } = mk();
  await gate.pause('a.com', 0);
  assert.deepEqual(waits, []); // ninguém na frente
  await gate.pause('a.com', 0);
  assert.deepEqual(waits, [1000]); // gap = jitter(1000) com random 0.5
});

test('hostgate: requests em rajada viram fila com gaps sequenciais', async () => {
  const { waits, gate } = mk();
  await gate.pause('a.com', 0);
  await gate.pause('a.com', 0);
  await gate.pause('a.com', 0);
  assert.deepEqual(waits, [1000, 1000]);
});

test('hostgate: crawl-delay do robots domina quando maior que o jitter', async () => {
  const { waits, gate } = mk();
  await gate.pause('a.com', 5000);
  await gate.pause('a.com', 5000);
  assert.deepEqual(waits, [5000]);
});

test('hostgate: crawl-delay tem teto de 30s (site hostil não trava o crawl)', async () => {
  const { waits, gate } = mk();
  await gate.pause('a.com', 600_000);
  await gate.pause('a.com', 600_000);
  assert.deepEqual(waits, [30_000]);
});

test('hostgate: hosts diferentes não se bloqueiam', async () => {
  const { waits, gate } = mk();
  await gate.pause('a.com', 0);
  await gate.pause('b.com', 0);
  assert.deepEqual(waits, []);
});

test('hostgate: depois de tempo ocioso o próximo request passa sem espera', async () => {
  const { clock, waits, gate } = mk();
  await gate.pause('a.com', 0);
  clock.t = 60_000; // muito depois da janela reservada
  await gate.pause('a.com', 0);
  assert.deepEqual(waits, []);
});
