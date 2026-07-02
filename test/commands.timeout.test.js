// Deadline por job (withTimeout): resolve normal quando cabe; rejeita com code JOB_TIMEOUT ao
// estourar; ms<=0 desliga o deadline. NC_HOME temporário ANTES do import (commands.js -> db.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-timeout-'));
const { withTimeout } = await import('../src/commands.js');
const { db } = await import('../src/db.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

const delay = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

test('resolve normalmente quando o trabalho cabe no deadline', async () => {
  assert.equal(await withTimeout(delay(10, 'ok'), 500), 'ok');
});

test('estourou -> rejeita com code JOB_TIMEOUT', async () => {
  await assert.rejects(() => withTimeout(delay(200, 'tarde'), 30), (e) => e.code === 'JOB_TIMEOUT');
});

test('ms<=0 desliga o deadline (nunca corta)', async () => {
  assert.equal(await withTimeout(delay(10, 'sem-deadline'), 0), 'sem-deadline');
});

test('propaga a rejeição original do trabalho (não mascara com timeout)', async () => {
  const boom = Promise.reject(Object.assign(new Error('falhou'), { code: 'BOOM' }));
  await assert.rejects(() => withTimeout(boom, 500), (e) => e.code === 'BOOM');
});
