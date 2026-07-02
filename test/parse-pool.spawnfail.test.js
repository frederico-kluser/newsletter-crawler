// Falha SÍNCRONA de spawn do worker (ctor rejeita protocolo != file:/data: com
// ERR_WORKER_UNSUPPORTED_URL): sem workers vivos, a fila não pode ficar estrandada (task na
// fila não tem timer) — runParse tem que resolver INLINE (fail-open), e após MAX_SPAWN_FAILS
// o pool se desativa de vez. Regressão do bug "runParse pendura p/ sempre em spawn-fail".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-spawnfail-'));
process.env.PARSE_WORKER_PATH = 'https://invalid.example/worker.js'; // ctor lança SÍNCRONO
process.env.PARSE_WORKERS = '2';

const { runParse, parsePoolState, closeParsePool } = await import('../src/parse-pool.js');

after(async () => {
  await closeParsePool();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

const HTML = '<html><body><p>corpo de teste com algum texto real aqui.</p></body></html>';

test('spawn falha sync + zero workers -> resolve INLINE (não pendura) com o resultado real', async () => {
  const out = await runParse('probablyArticle', [HTML, 'https://x.test/a'], 'DEFAULT');
  assert.notEqual(out, 'DEFAULT' === out ? 'nunca' : undefined); // resolveu (não pendurou)
  assert.equal(typeof out, 'boolean', 'probablyArticle inline devolve boolean, não o default');
  assert.equal(parsePoolState().queued, 0, 'fila drenada');
});

test('após MAX_SPAWN_FAILS o pool se desativa e segue 100% inline', async () => {
  await runParse('probablyArticle', [HTML, 'https://x.test/b'], false);
  await runParse('probablyArticle', [HTML, 'https://x.test/c'], false);
  assert.equal(parsePoolState().disabled, true, '3 falhas de spawn -> desativado');
  const again = await runParse('probablyArticle', [HTML, 'https://x.test/d'], false);
  assert.equal(typeof again, 'boolean');
});
