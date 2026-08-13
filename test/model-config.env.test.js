// Override por env (precedência env > arquivo > default) na resolução de modelos por estágio.
// Processo isolado (o node --test roda cada arquivo num processo próprio): as variáveis precisam
// estar setadas ANTES do import dinâmico, porque MODELS/STAGE_MODELS são pré-computados no load
// do config.js. Ambiente é restaurado no after() e o NC_HOME vai para um tmp (nada do usuário real).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SWAPPED_SLUG = 'deepseek/deepseek-v4-flash-0731';

// Override FINO: só summarize troca de modelo (e effort); searchSpec exercita o guard "max"->xhigh.
const saved = {};
process.env.NC_HOME = mkdtempSync(path.join(tmpdir(), 'nc-model-env-'));
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LLM_') || k.startsWith('CLASSIFY_')) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
}
process.env.LLM_MODEL_SUMMARIZE = 'some/vendor-x';
process.env.LLM_EFFORT_SUMMARIZE = 'medium';
process.env.LLM_EFFORT_SEARCH_SPEC = 'max'; // DeepSeek V4 rejeita "max" com HTTP 400 -> guard rebaixa

const { stageModel } = await import('../src/config.js');

after(() => {
  for (const [k, v] of Object.entries(saved)) process.env[k] = v; // restaura o ambiente original
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

test('LLM_MODEL_SUMMARIZE=<slug> -> stageModel("summarize") usa o slug do env (env > arquivo)', () => {
  assert.equal(stageModel('summarize').model, 'some/vendor-x');
  assert.equal(stageModel('summarize').effort, 'medium', 'LLM_EFFORT_SUMMARIZE também vence o arquivo');
});

test('override é FINO: os outros estágios seguem no slug da troca', () => {
  assert.equal(stageModel('classify').model, SWAPPED_SLUG);
  assert.equal(stageModel('searchBatch').model, SWAPPED_SLUG);
  assert.equal(stageModel('curate').model, SWAPPED_SLUG);
  assert.equal(stageModel('summarize').model, 'some/vendor-x', 'só o estágio overrideado muda');
});

test('guard "max": LLM_EFFORT_SEARCH_SPEC=max resolve p/ xhigh (DeepSeek V4 rejeita max com 400)', () => {
  assert.equal(stageModel('searchSpec').effort, 'xhigh');
  assert.equal(stageModel('searchSpec').model, SWAPPED_SLUG);
});
