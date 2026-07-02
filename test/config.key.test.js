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
