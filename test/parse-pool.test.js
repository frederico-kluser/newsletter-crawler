// Pool de parsing: correção do caminho worker, resposta a op desconhecida, e — o ponto central
// da melhoria — RESTART on crash e TIMEOUT resolvem com o default seguro E o pool segue vivo.
// Usa o fixture crash-worker.js (via PARSE_WORKER_PATH) p/ forçar crash/hang deterministicamente.
// NC_HOME temporário + envs ANTES do import (config.js lê no load).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-pool-'));
process.env.PARSE_WORKER_PATH = '../test/fixtures/crash-worker.js'; // relativo a src/parse-pool.js
process.env.PARSE_WORKERS = '2';
process.env.PARSE_TIMEOUT_MS = '400';

const { runParse, closeParsePool, parsePoolState } = await import('../src/parse-pool.js');

after(async () => {
  await closeParsePool();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

test('worker responde ops normais (echo) e o pool sobe até PARSE_WORKERS', async () => {
  const outs = await Promise.all([
    runParse('echo', ['a'], null),
    runParse('echo', ['b'], null),
    runParse('echo', ['c'], null),
  ]);
  assert.deepEqual(outs.sort(), ['a', 'b', 'c']);
  assert.ok(parsePoolState().workers <= 2, 'não passa do teto de workers');
});

test('op desconhecida resolve com o default seguro (sem crash)', async () => {
  assert.equal(await runParse('naoexiste', [], 'DEFAULT'), 'DEFAULT');
});

test('CRASH do worker (process.exit) -> task resolve default E o pool respawna e segue', async () => {
  const crashed = await runParse('crash', [], 'SAFE');
  assert.equal(crashed, 'SAFE', 'a task que matou o worker resolve com o default seguro');
  // O pool tem que continuar funcional depois do respawn:
  const after1 = await runParse('echo', ['vivo'], null);
  assert.equal(after1, 'vivo', 'pool respawnou e voltou a atender');
  // rajada pós-crash: várias em paralelo continuam corretas
  const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => runParse('echo', [i], null)));
  assert.deepEqual(burst, [0, 1, 2, 3, 4, 5]);
});

test('TIMEOUT por task (worker que trava) -> default seguro, e o pool segue vivo', async () => {
  const hung = await runParse('hang', [], 'TIMED_OUT');
  assert.equal(hung, 'TIMED_OUT');
  assert.equal(await runParse('echo', ['ok'], null), 'ok', 'pós-timeout o pool ainda atende');
});
