// Provider inválido no LOAD clampeia p/ openrouter (comportamento de sempre, sem auto-detecção):
// LLM_PROVIDER=gemini -> 'openrouter', e a chave DEEPSEEK_API_KEY presente no env NÃO conta
// (HAS_LLM/providerInfo são do provider ATIVO). setRuntimeKey com 1 arg segue no provider atual.
// Processo isolado (node --test = 1 processo por arquivo): env setado ANTES do import dinâmico.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-config-invalid-'));
process.env.NC_HOME = NC_HOME_TMP;
// Semeia o NC_HOME/.env do TMP com o env do teste: no load do config.js ele é o ÚLTIMO a ser lido
// (precedência documentada: shell < .env do repo < NC_HOME/.env), então vence o .env do REPO real
// (ROOT/.env — a máquina de integração tem chaves reais lá e o loadDotEnvOverride as leria por
// cima do delete abaixo). Chave que DEVE ficar ausente entra como linha de valor vazio.
writeFileSync(
  path.join(NC_HOME_TMP, '.env'),
  'LLM_PROVIDER=gemini\nDEEPSEEK_API_KEY=sk-ds-only\nOPENROUTER_API_KEY=\n',
);
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) {
    delete process.env[k];
  }
}
process.env.LLM_PROVIDER = 'gemini'; // inválido -> clamp 'openrouter' no load
process.env.DEEPSEEK_API_KEY = 'sk-ds-only'; // chave do deepseek presente, mas o ativo é openrouter
process.on('exit', () => rmSync(NC_HOME_TMP, { recursive: true, force: true }));

const config = await import('../src/config.js');

test('load: LLM_PROVIDER inválido clampeia p/ openrouter; a chave deepseek NÃO vira HAS_LLM', () => {
  assert.equal(config.LLM_PROVIDER, 'openrouter', 'inválido/ausente -> openrouter (comportamento de sempre)');
  assert.deepEqual(config.providerInfo(), {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    keyVar: 'OPENROUTER_API_KEY',
    keyPresent: false, // só existe chave deepseek no env -> não conta p/ o provider ativo
  });
  assert.equal(config.HAS_LLM, false);
  assert.equal(config.DEEPSEEK_API_KEY, 'sk-ds-only', 'a chave do outro provider fica guardada, sem efeito');
  assert.equal(config.translateModel('deepseek/deepseek-v4-flash-0731'), 'deepseek/deepseek-v4-flash-0731');
});

test('setRuntimeKey com 1 arg no provider clampeado: ativa a chave do openrouter, deepseek intocada', () => {
  config.setRuntimeKey('sk-or-v1-runtime'); // contrato antigo: provider atual (openrouter)
  assert.equal(config.LLM_PROVIDER, 'openrouter');
  assert.equal(config.HAS_LLM, true);
  assert.equal(config.OPENROUTER_API_KEY, 'sk-or-v1-runtime');
  assert.equal(process.env.OPENROUTER_API_KEY, 'sk-or-v1-runtime');
  assert.equal(config.DEEPSEEK_API_KEY, 'sk-ds-only', 'setRuntimeKey 1 arg não mexe na chave deepseek');
});
