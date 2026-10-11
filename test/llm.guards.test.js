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

const {
  stageMaxTokens, DEFAULT_MAX_TOKENS, reasoningTokensAllowance, DEFAULT_REASONING_ALLOWANCE,
} = await import('../src/config.js');
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

test('max_tokens POR STAGE vai no body de TODA chamada = teto de SAÍDA + folga de raciocínio', async () => {
  // Em modelos de raciocínio o max_tokens cobre reasoning + CONTEÚDO (medido 2026-10-11: sem a
  // folga, o raciocínio consome o teto e o content vem VAZIO → "JSON inválido" em loop de retry).
  calls.length = 0;
  await chama('classify');
  await chama('articleExtract');
  assert.equal(calls[0].body.max_tokens, 4000 + DEFAULT_REASONING_ALLOWANCE);
  assert.equal(calls[1].body.max_tokens, 36000 + DEFAULT_REASONING_ALLOWANCE);
  // Env override da folga (0 = comportamento antigo, sem folga).
  process.env.LLM_REASONING_ALLOWANCE = '500';
  await chama('classify');
  delete process.env.LLM_REASONING_ALLOWANCE;
  assert.equal(calls[2].body.max_tokens, 4500, 'env LLM_REASONING_ALLOWANCE vence o default');
  process.env.LLM_REASONING_ALLOWANCE = '0';
  assert.equal(reasoningTokensAllowance(), 0, '0 desliga a folga (explicitamente)');
  await chama('classify');
  delete process.env.LLM_REASONING_ALLOWANCE;
  assert.equal(calls[3].body.max_tokens, 4000, 'sem folga = teto de saída puro');
  assert.equal(reasoningTokensAllowance(), DEFAULT_REASONING_ALLOWANCE, 'default restaurado');
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

test('REASONING a gastar a folga inteira NÃO é resposta degenerada', async () => {
  // O caso medido de 2026-10-11: reasoning_tokens == completion_tokens == max_tokens com content
  // VAZIO era truncamento (folga a menos), não loop — o guard não pode re-amostrar por reasoning.
  calls.length = 0;
  createImpl = async () => ({
    model: 'm',
    usage: {
      prompt_tokens: 10,
      completion_tokens: 11_000, // dentro do enviado (4000 + 8000 folga)
      completion_tokens_details: { reasoning_tokens: 10_500 }, // 500 de conteúdo
    },
    choices: [{ message: { content: '{"ok":true}' } }],
  });
  const parsed = await chama('classify');
  assert.deepEqual(parsed, { ok: true }, 'resposta com reasoning longo parseia normalmente');
  assert.equal(calls.length, 1, 'SEM re-amostra: reasoning ≠ lixo');
});

test('CONTEÚDO acima do teto de SAÍDA é degenerado mesmo com folga de raciocínio', async () => {
  // O loop de geração original (2026-10-10) é conteúdo, não reasoning: o teto de saída continua a
  // valer para ele, agora medido só no conteúdo (completion − reasoning).
  calls.length = 0;
  createImpl = async () => ({
    model: 'm',
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20_000,
      completion_tokens_details: { reasoning_tokens: 100 }, // 19.900 de CONTEÚDO = loop
    },
    choices: [{ message: { content: '{"ok":true}' } }], // JSON válido: é o lixo que não se aceita
  });
  await assert.rejects(() => chama('classify'), /degenerada/);
  assert.equal(calls.length, 2, 're-amostra antes de desistir');
});

test('corte duro: SEMPRE há signal na request e o timeout aborta uma stream pendurada', async () => {
  calls.length = 0;
  // Handler que nunca resolve — só rejeita quando o signal aborta (o que o mock do SDK real faria).
  // O keep-alive é NECESSÁRIO: o timer do AbortSignal.timeout é unref'd e não segura o event loop —
  // sem ele o loop drena e o node:test cancela os testes pendentes (verificado no CI, Node 22:
  // "Promise resolution is still pending but the event loop has already resolved").
  createImpl = (body, options) =>
    new Promise((_, rej) => {
      const keep = setTimeout(() => rej(new Error('backstop: abort nunca chegou')), 5000);
      const done = (r) => { clearTimeout(keep); rej(r ?? new Error('aborted')); };
      const s = options?.signal;
      if (!s) return done(new Error('sem signal'));
      if (s.aborted) return done(s.reason);
      s.addEventListener('abort', () => done(s.reason), { once: true });
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
      const keep = setTimeout(() => rej(new Error('backstop: abort nunca chegou')), 5000);
      const done = (r) => { clearTimeout(keep); rej(r ?? new Error('aborted')); };
      const s = options?.signal;
      if (s?.aborted) return done(s.reason);
      s?.addEventListener('abort', () => done(s.reason), { once: true });
    });
  const ac = new AbortController();
  const p = chama('classify', { signal: ac.signal });
  setTimeout(() => ac.abort(new Error('job morto')), 20);
  const t0 = Date.now();
  await assert.rejects(() => p, /job morto/);
  assert.ok(Date.now() - t0 < 1500, 'abort do job não espera o timeout do SDK');
});

// ---- retry de TRANSPORTE transitório (medido 2026-10-11: 16/137 classify penduraram 180s e
// morreram sem retry → faceta perdida, artigo 'partial') ----

const timeoutError = () => {
  const e = new Error('The operation was aborted due to timeout');
  e.name = 'TimeoutError';
  return e;
};

test('transporte transitório (timeout duro) re-tenta numa requisição NOVA e resolve', async () => {
  calls.length = 0;
  let n = 0;
  createImpl = async () => {
    n++;
    if (n === 1) throw timeoutError(); // o provider pendurou; o timeout duro cortou
    return {
      model: 'm',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [{ message: { content: '{"ok":true}' } }],
    };
  };
  const parsed = await chama('classify');
  assert.deepEqual(parsed, { ok: true }, 'a 2ª amostra entra e resolve');
  assert.equal(calls.length, 2, 're-tentou EXATAMENTE uma vez (1 hang + 1 sucesso)');
});

test('5xx do provider re-tenta; esgotado, lança (máx. 3 tentativas)', async () => {
  calls.length = 0;
  createImpl = async () => {
    const e = new Error('Bad Gateway');
    e.status = 502;
    throw e;
  };
  await assert.rejects(() => chama('classify'), /Bad Gateway/);
  assert.equal(calls.length, 3, '2 re-tentativas antes de desistir');
});

test('4xx (pedido/key) NÃO re-tenta', async () => {
  calls.length = 0;
  createImpl = async () => {
    const e = new Error('Bad Request');
    e.status = 400;
    throw e;
  };
  await assert.rejects(() => chama('classify'), /Bad Request/);
  assert.equal(calls.length, 1, 'erro do pedido vai direto: re-tentar só repete o mesmo 400');
});

test('abort do JOB no meio do transporte NÃO re-tenta (deadline/cancel manda)', async () => {
  calls.length = 0;
  const ac = new AbortController();
  createImpl = async () => {
    ac.abort(new Error('job morto')); // o job abortou em voo → erro de transporte, mas do JOB
    throw timeoutError();
  };
  await assert.rejects(() => chama('classify', { signal: ac.signal }), /job morto/);
  assert.equal(calls.length, 1, 'job abortado não gera retentativa fantasma');
});
