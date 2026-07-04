// removeSourceFromConfig: descadastra uma fonte do sources.json (par do addSourceToConfig). Sem
// isso, uma fonte apagada do banco voltaria no próximo crawl (o seed re-semeia do JSON). Arquivo
// TEMP (não toca no real); upsert/remoção por URL normalizada; idempotente. npm test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { addSourceToConfig, removeSourceFromConfig } from '../src/config.js';

const tmp = path.join(os.tmpdir(), `nc-rmsources-${process.pid}.json`);
after(() => rmSync(tmp, { force: true }));

test('removeSourceFromConfig: remove por URL normalizada (barra final + utm)', () => {
  addSourceToConfig({ name: 'AI Weekly', url: 'https://aiweekly.co/issues', type: 'index' }, tmp);
  addSourceToConfig({ name: 'The Batch', url: 'https://deeplearning.ai/the-batch' }, tmp);
  assert.equal(JSON.parse(readFileSync(tmp, 'utf8')).sources.length, 2);

  // URL equivalente (barra + utm) deve casar a mesma entrada normalizada.
  const r = removeSourceFromConfig('https://aiweekly.co/issues/?utm_source=x', tmp);
  assert.equal(r.removed, true);
  const data = JSON.parse(readFileSync(tmp, 'utf8'));
  assert.equal(data.sources.length, 1);
  assert.equal(data.sources[0].name, 'The Batch');
});

test('removeSourceFromConfig: idempotente (remover de novo não quebra e não muda nada)', () => {
  const r = removeSourceFromConfig('https://aiweekly.co/issues', tmp);
  assert.equal(r.removed, false);
  assert.equal(JSON.parse(readFileSync(tmp, 'utf8')).sources.length, 1);
});

test('removeSourceFromConfig: arquivo ausente é fail-open (removed=false)', () => {
  const missing = path.join(os.tmpdir(), `nc-nope-${process.pid}.json`);
  const r = removeSourceFromConfig('https://x.com/', missing);
  assert.deepEqual(r, { removed: false, total: 0 });
});
