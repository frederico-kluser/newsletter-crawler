// Alvo MORTO (DNS não resolve / conexão recusada / SSL morto): o fallback para Playwright usa o
// MESMO resolver e falha igual — só multiplicava o ruído (2 tentativas × MAX_RETRIES erros por
// run, era o que o usuário via como "muitas dão erro"). `isDeadTargetError` é o classificador que
// corta o fallback e faz o dispatch encerrar o job sem retry no run (o item nunca é aposentado:
// needs_enrich=1 e o próximo crawl re-tenta).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-dead-target-'));
const { isDeadTargetError, isDownloadError } = await import('../src/fetch.js');
const { db } = await import('../src/db.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

test('DNS morto é alvo morto (estático e browser morrem igual)', () => {
  assert.equal(isDeadTargetError(new Error('getaddrinfo ENOTFOUND blog.toonk.com')), true);
  assert.equal(isDeadTargetError(new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://blog.toonk.com/x')), true);
});

test('conexão recusada / rede inalcançável / SSL morto são alvos mortos', () => {
  assert.equal(isDeadTargetError(new Error('connect ECONNREFUSED 91.98.198.236:443')), true);
  assert.equal(isDeadTargetError(new Error('page.goto: net::ERR_CONNECTION_REFUSED at https://releaserun.com/go-releases')), true);
  assert.equal(isDeadTargetError(new Error('page.goto: net::ERR_SSL_PROTOCOL_ERROR at https://www.mastro.ai/x')), true);
  assert.equal(isDeadTargetError(new Error('connect ENETUNREACH 1.2.3.4:443')), true);
});

test('bloqueio/timeout/HTTP NÃO são alvo morto (merecem browser/retry)', () => {
  assert.equal(isDeadTargetError(new Error('Request failed with status code 403 (Forbidden)')), false);
  assert.equal(isDeadTargetError(new Error('Timeout awaiting request for 30000ms')), false);
  assert.equal(isDeadTargetError(new Error('Request failed with status code 500 (Internal)')), false);
  assert.equal(isDownloadError(new Error('net::ERR_ABORTED ... Download is starting')), true);
});
