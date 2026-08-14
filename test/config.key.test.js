// Key dinâmica em runtime (live bindings ESM): setRuntimeKey atualiza HAS_LLM/OPENROUTER_API_KEY
// para TODOS os importadores sem reiniciar — é o que permite o modal da web ativar a key na hora.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-key-test-'));
process.env.NC_HOME = NC_HOME_TMP; // NC_HOME/.env do tmp não existe — nada sobrescreve depois
process.on('exit', () => rmSync(NC_HOME_TMP, { recursive: true, force: true }));

const config = await import('../src/config.js');

test('setRuntimeKey: liga/desliga HAS_LLM em runtime e propaga via live binding', () => {
  const original = config.OPENROUTER_API_KEY; // restaura no fim (o import pode ter achado uma key)

  config.setRuntimeKey('');
  assert.equal(config.HAS_LLM, false, 'sem key -> HAS_LLM false');
  assert.equal(config.OPENROUTER_API_KEY, '');

  config.setRuntimeKey('sk-or-v1-teste');
  assert.equal(config.HAS_LLM, true, 'key setada em runtime -> HAS_LLM true SEM reimport');
  assert.equal(config.OPENROUTER_API_KEY, 'sk-or-v1-teste');
  assert.equal(process.env.OPENROUTER_API_KEY, 'sk-or-v1-teste', 'process.env acompanha');

  config.setRuntimeKey(original);
  assert.equal(config.HAS_LLM, Boolean(original));
});

test('setRuntimeKey: troca de provider em runtime (deepseek) atualiza DEEPSEEK_API_KEY/HAS_LLM', () => {
  const origOr = config.OPENROUTER_API_KEY; // restaura no fim (o import pode ter achado uma key)
  const origDs = config.DEEPSEEK_API_KEY;
  const origProvider = config.LLM_PROVIDER;

  // Troca p/ deepseek com chave: a chave passa a valer no DEEPSEEK_API_KEY.
  config.setRuntimeKey('sk-ds-v1-teste', 'deepseek');
  assert.equal(config.LLM_PROVIDER, 'deepseek');
  assert.equal(config.HAS_LLM, true, 'key deepseek setada em runtime -> HAS_LLM true');
  assert.equal(config.DEEPSEEK_API_KEY, 'sk-ds-v1-teste');
  assert.equal(process.env.DEEPSEEK_API_KEY, 'sk-ds-v1-teste', 'process.env acompanha');
  assert.equal(config.providerInfo().keyVar, 'DEEPSEEK_API_KEY');

  // Volta p/ openrouter com a chave original (provider default).
  config.setRuntimeKey(origOr, 'openrouter');
  assert.equal(config.LLM_PROVIDER, 'openrouter');
  assert.equal(config.OPENROUTER_API_KEY, origOr);

  // Restaura o estado original completo (inclusive se o ambiente iniciou em deepseek).
  config.setRuntimeKey(origProvider === 'deepseek' ? origDs : origOr, origProvider);
  assert.equal(config.LLM_PROVIDER, origProvider);
  assert.equal(config.HAS_LLM, Boolean(origProvider === 'deepseek' ? origDs : origOr));
});
