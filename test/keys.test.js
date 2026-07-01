// Eval do keys.js: upsertEnvVar grava/atualiza a chave num .env preservando outras linhas (usado
// pelo `ncrawl key set`), e maskKey mascara para log. Usa arquivo TEMP; não toca no NC_HOME real.
// probeOpenRouterKey (rede) NÃO é testado aqui — é validado pelo probe real no `key test`. npm test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { upsertEnvVar, maskKey } from '../src/keys.js';

const tmp = path.join(os.tmpdir(), `nc-env-${process.pid}.env`);
after(() => rmSync(tmp, { force: true }));

test('upsertEnvVar: cria o arquivo com a chave', () => {
  const r = upsertEnvVar('OPENROUTER_API_KEY', 'sk-or-abc', tmp);
  assert.equal(r.updated, false);
  assert.match(readFileSync(tmp, 'utf8'), /^OPENROUTER_API_KEY=sk-or-abc$/m);
});

test('upsertEnvVar: atualiza a chave existente sem duplicar e preserva outras linhas', () => {
  writeFileSync(tmp, 'FOO=bar\nOPENROUTER_API_KEY=old\nBAZ=qux\n');
  const r = upsertEnvVar('OPENROUTER_API_KEY', 'new', tmp);
  assert.equal(r.updated, true);
  const txt = readFileSync(tmp, 'utf8');
  assert.match(txt, /^FOO=bar$/m, 'preserva linhas anteriores');
  assert.match(txt, /^BAZ=qux$/m, 'preserva linhas posteriores');
  assert.match(txt, /^OPENROUTER_API_KEY=new$/m, 'atualiza o valor');
  assert.equal((txt.match(/^OPENROUTER_API_KEY=/gm) || []).length, 1, 'não duplica a chave');
});

test('maskKey: mantém prefixo + sufixo e trata vazio', () => {
  assert.equal(maskKey('sk-or-v1-abcdef1234'), 'sk-or-v1…1234');
  assert.equal(maskKey(''), '(vazia)');
  assert.equal(maskKey('curta'), 'cu…');
});
