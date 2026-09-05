// Eval do addSourceToConfig: adicionar pela interface persiste no config/sources.json (permanente),
// com upsert por URL normalizada. Usa um arquivo TEMP (não toca no config real). npm test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// NC_HOME temporário ANTES do import (config.js): no load, config.js cria/semeia o
// NC_HOME REAL do usuário e carrega o .env dele. Import dinâmico porque o `import`
// estático é IÇADO — rodaria antes desta linha.
process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-addsource-home-'));
after(() => rmSync(process.env.NC_HOME, { recursive: true, force: true }));
const { addSourceToConfig } = await import('../src/config.js');

const tmp = path.join(os.tmpdir(), `nc-sources-${process.pid}.json`);
after(() => rmSync(tmp, { force: true }));

test('addSourceToConfig: cria o arquivo e adiciona a fonte', () => {
  const r = addSourceToConfig({ name: 'AI Weekly', url: 'https://aiweekly.co/issues', type: 'index', maxIndexPages: 1 }, tmp);
  assert.equal(r.added, true);
  const data = JSON.parse(readFileSync(tmp, 'utf8'));
  assert.equal(data.sources.length, 1);
  assert.deepEqual(data.sources[0], {
    name: 'AI Weekly', url: 'https://aiweekly.co/issues', type: 'index', maxIndexPages: 1,
  });
});

test('addSourceToConfig: upsert por URL normalizada (não duplica; atualiza campos)', () => {
  // Mesma URL com barra final + utm -> normaliza para a mesma; deve ATUALIZAR, não duplicar.
  const r = addSourceToConfig({ name: 'AI Weekly BR', url: 'https://aiweekly.co/issues/?utm_source=x', type: 'index' }, tmp);
  assert.equal(r.added, false);
  const data = JSON.parse(readFileSync(tmp, 'utf8'));
  assert.equal(data.sources.length, 1, 'não deve duplicar');
  assert.equal(data.sources[0].name, 'AI Weekly BR', 'nome atualizado');
});

test('addSourceToConfig: segunda fonte distinta é adicionada', () => {
  const r = addSourceToConfig({ name: 'The Batch', url: 'https://www.deeplearning.ai/the-batch/tag/research' }, tmp);
  assert.equal(r.added, true);
  const data = JSON.parse(readFileSync(tmp, 'utf8'));
  assert.equal(data.sources.length, 2);
});
