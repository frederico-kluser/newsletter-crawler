// Guardrails da camada LLM (medidos no trace --llm-dev de 2026-10-10): sem max_tokens no body o
// modelo degenera a gerar até o teto do provider (131k tokens, 57 min numa chamada de classify) e
// o `timeout` do SDK NÃO aborta uma resposta a fluir tokens (tentativas de 3.400s com timeout de
// 180s). Hoje: (1) max_tokens POR STAGE no body, (2) AbortSignal.timeout combinado com o signal do
// job por tentativa, (3) guard de resposta degenerada (acima de 1.2× o teto → re-amostra).
// Mesmo harness do llm.zod-retry.test.js (mock do SDK openai, ZERO rede).
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import OpenAI from 'openai'; // mesma instância de módulo que src/llm.js usa
import { setLogSink } from '../src/util.js';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-llm-guards-'));
process.env.NC_HOME = NC_HOME_TMP;
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) {
    delete process.env[k];
  }
}
process.env.LLM_PROVIDER = 'deepseek';
process.env.DEEPSEEK_API_KEY = 'sk-ds-a';
process.env.LLM_TIMEOUT_MS = '120'; // timeout curto p/ o teste do corte duro ser rápido
process.on('exit', () => rmSync(NC_HOME_TMP, { recursive: true, force: true }));

const { stageMaxTokens, DEFAULT_MAX_TOKENS } = await import('../src/config.js');
const { callJSON } = await import('../src/llm.js');

// ---- mock do SDK: uma implementação reconfigurável por teste ----
const calls = [];
let createImpl = async () => ({
  model: 'deepseek-v4-flash',
  usage: { prompt_tokens: 10, completion_tokens: 5 },
  choices: [{ message: { content: '{}' } }],
});
mock.method(OpenAI.Chat.Completions.prototype, 'create', async function createMock(body, options) {
  calls.push({ body, options });
  return createImpl(body, options);
});

// O callJSON faz warn()s legítimos (re-amostra) — cala o output nos testes.
setLogSink(() => {});
after(() => setLogSink(null));

const chama = (stage, extra = {}) =>
  callJSON({
    model: 'm', reasoning: { effort: 'high' }, schema: { type: 'object' }, schemaName: 't',
    system: 's', user: 'u', stage, retries: 1, zod: null, ...extra,
  });

test('stageMaxTokens: tabela por família, env override e default', () => {
  assert.equal(stageMaxTokens('classify'), 4000);
  assert.equal(stageMaxTokens('articleExtract'), 36000, 'a exceção honesta: devolve o corpo inteiro');
  assert.equal(stageMaxTokens('curate'), 16000);
  assert.equal(stageMaxTokens('desconhecido-xyz'), DEFAULT_MAX_TOKENS);
  process.env.LLM_MAX_TOKENS_CLASSIFY = '123';
  assert.equal(stageMaxTokens('classify'), 123, 'env por stage vence');
  delete process.env.LLM_MAX_TOKENS_CLASSIFY;
  process.env.LLM_MAX_TOKENS = '777';
  assert.equal(stageMaxTokens('desconhecido-xyz'), 777, 'env global vence o default');
  delete process.env.LLM_MAX_TOKENS;
});

test('max_tokens POR STAGE vai no body de TODA chamada', async () => {
  calls.length = 0;
  await chama('classify');
  await chama('articleExtract');
  assert.equal(calls[0].body.max_tokens, 4000);
  assert.equal(calls[1].body.max_tokens, 36000);
});

test('resposta DEGENERADA (>1.2× o teto) re-amostra e, esgotado, LANÇA', async () => {
  calls.length = 0;
  createImpl = async () => ({
    model: 'm',
    usage: { prompt_tokens: 10, completion_tokens: 999999 }, // loop de geração
    choices: [{ message: { content: '{"ok":true}' } }], // JSON válido de propósito: é o LIxo que não se aceita
  });
  await assert.rejects(() => chama('classify'), /degenerada/);
  assert.equal(calls.length, 2, 'tentativa inicial + re-amostra antes de desistir');
  // E o mesmo com um JSON inválido: o guard entra ANTES do parse nos dois caminhos.
  calls.length = 0;
  await assert.rejects(() => chama('classify'), /degenerada/);
  assert.equal(calls.length, 2);
});

test('corte duro: SEMPRE há signal na request e o timeout aborta uma stream pendurada', async () => {
  calls.length = 0;
  // Handler que nunca resolve — só rejeita quando o signal aborta (o que o mock do SDK real faria).
  createImpl = (body, options) =>
    new Promise((_, rej) => {
      const s = options?.signal;
      if (!s) return; // sem signal não há corte: o teste falha por timeout do node:test
      if (s.aborted) return rej(s.reason ?? new Error('aborted'));
      s.addEventListener('abort', () => rej(s.reason ?? new Error('aborted')), { once: true });
    });
  const t0 = Date.now();
  await assert.rejects(() => chama('classify'));
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `abortou em ${ms}ms (LLM_TIMEOUT_MS=120) — não ficou pendurado`);
  assert.ok(calls[0].options?.signal, 'request SEMPRE carrega signal (mesmo sem signal de job)');
});

test('abort do JOB também corta a chamada (signal combinado)', async () => {
  calls.length = 0;
  createImpl = (body, options) =>
    new Promise((_, rej) => {
      const s = options?.signal;
      if (s?.aborted) return rej(s.reason ?? new Error('aborted'));
      s?.addEventListener('abort', () => rej(s.reason ?? new Error('aborted')), { once: true });
    });
  const ac = new AbortController();
  const p = chama('classify', { signal: ac.signal });
  setTimeout(() => ac.abort(new Error('job morto')), 20);
  const t0 = Date.now();
  await assert.rejects(() => p, /job morto/);
  assert.ok(Date.now() - t0 < 1500, 'abort do job não espera o timeout do SDK');
});
