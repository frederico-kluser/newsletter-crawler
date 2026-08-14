// Testes do suporte a PROVEDOR LLM no webapp (BYOK): resolução do provider salvo (storage),
// mapeamento de slug p/ id direto da DeepSeek, custo local por tokens (tabela de preços) e o
// transporte callJSON/probeKey por provider (fetch mockado — sem rede).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  callJSON, deepseekCostFromUsage, deepseekModelId, KeyInvalidError, probeKey,
} from '../src/lib/openrouter.js';
import { clearProvider, getProvider, setProvider } from '../src/lib/storage.js';

// ---- storage: resolução do provider salvo (migração silenciosa) ----

test('getProvider: sem valor salvo = openrouter (migração silenciosa de chaves antigas)', () => {
  clearProvider();
  assert.equal(getProvider(), 'openrouter');
});

test('getProvider: só "deepseek" liga o modo direto; qualquer outro valor cai em openrouter', () => {
  setProvider('deepseek');
  assert.equal(getProvider(), 'deepseek');
  setProvider('openrouter');
  assert.equal(getProvider(), 'openrouter');
  setProvider('banana');
  assert.equal(getProvider(), 'openrouter'); // valor desconhecido → default
  clearProvider();
  assert.equal(getProvider(), 'openrouter'); // limpar volta ao default
});

// ---- DeepSeek direto: id de modelo ----

test('deepseekModelId: slug da OpenRouter vira o id direto (sem prefixo/versão)', () => {
  assert.equal(deepseekModelId('deepseek/deepseek-v4-flash-0731'), 'deepseek-v4-flash');
  assert.equal(deepseekModelId('deepseek/deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.equal(deepseekModelId('deepseek-v4-flash'), 'deepseek-v4-flash'); // já é id direto
  assert.equal(deepseekModelId(''), 'deepseek-v4-flash'); // vazio → default
  assert.equal(deepseekModelId('anthropic/claude-sonnet-4'), 'anthropic/claude-sonnet-4'); // estranho passa reto
});

// ---- DeepSeek direto: custo local (a API não traz usage.cost) ----

test('deepseekCostFromUsage: tokens × tarifa (hit/miss/output), tarifa flash', () => {
  // flash: 0.0028 hit / 0.14 input / 0.28 output por 1M tokens
  const usage = {
    prompt_cache_hit_tokens: 500_000,
    prompt_cache_miss_tokens: 500_000,
    completion_tokens: 500_000,
  };
  const c = deepseekCostFromUsage(usage, 'deepseek-v4-flash');
  assert.ok(Math.abs(c - (0.5 * 0.0028 + 0.5 * 0.14 + 0.5 * 0.28)) < 1e-9);
});

test('deepseekCostFromUsage: tarifa pro é mais cara e modelId fora da tabela cai na flash', () => {
  const usage = { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1_000_000, completion_tokens: 1_000_000 };
  const pro = deepseekCostFromUsage(usage, 'deepseek-v4-pro');
  assert.ok(Math.abs(pro - (0.435 + 0.87)) < 1e-9);
  const unknown = deepseekCostFromUsage(usage, 'deepseek-v4-unknown');
  assert.ok(Math.abs(unknown - (0.14 + 0.28)) < 1e-9); // fallback flash
});

test('deepseekCostFromUsage: fallback p/ prompt_tokens_details.cached_tokens quando faltam os campos novos', () => {
  const usage = { prompt_tokens: 100, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 25 } };
  const c = deepseekCostFromUsage(usage, 'deepseek-v4-flash');
  assert.ok(Math.abs(c - (25 / 1e6 * 0.0028 + 75 / 1e6 * 0.14 + 200 / 1e6 * 0.28)) < 1e-12);
});

test('deepseekCostFromUsage: usage ausente/inválido → 0 (fail-open)', () => {
  assert.equal(deepseekCostFromUsage(null, 'deepseek-v4-flash'), 0);
  assert.equal(deepseekCostFromUsage(undefined, 'deepseek-v4-flash'), 0);
  assert.equal(deepseekCostFromUsage({}, 'deepseek-v4-flash'), 0);
});

// ---- transporte: callJSON por provider (fetch mockado) ----

const okRes = (json) => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => json });
const completion = (content, usage, cost) => ({
  choices: [{ message: { content } }],
  usage: cost !== undefined ? { ...usage, cost } : usage,
});

function mockFetch(fn) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return fn(url, opts, calls.length);
  };
  return calls;
}

test('callJSON openrouter: envia reasoning/usage:{include:true}/json_schema e usa usage.cost', async () => {
  const calls = mockFetch((url) =>
    okRes(completion('{"relation":"direct","kind":"news"}', { prompt_tokens: 10, completion_tokens: 5 }, 0.00123)));
  let cost = 0;
  const out = await callJSON({
    provider: 'openrouter', apiKey: 'sk-or-x', model: 'deepseek/deepseek-v4-flash-0731',
    effort: 'high', schemaName: 'relevance', schema: { type: 'object' }, user: 'u', onCost: (c) => (cost = c),
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith('https://openrouter.ai/api/v1/chat/completions'));
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.deepEqual(body.usage, { include: true });
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.model, 'deepseek/deepseek-v4-flash-0731'); // slug intocado no OR
  assert.equal(cost, 0.00123); // custo REAL vindo do usage.cost
  assert.deepEqual(out, { relation: 'direct', kind: 'news' });
});

test('callJSON deepseek: SEM reasoning/usage, response_format json_object, modelo mapeado e custo LOCAL', async () => {
  const calls = mockFetch(() =>
    okRes(completion('{"relation":"direct","kind":"news"}', {
      prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1_000_000, completion_tokens: 1_000_000,
    })));
  let cost = 0;
  const out = await callJSON({
    provider: 'deepseek', apiKey: 'sk-ds-x', model: 'deepseek/deepseek-v4-flash-0731',
    effort: 'high', schemaName: 'relevance', schema: { type: 'object' }, user: 'u', onCost: (c) => (cost = c),
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith('https://api.deepseek.com/chat/completions'));
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.reasoning, undefined); // NÃO envia reasoning
  assert.equal(body.usage, undefined); // NÃO envia usage:{include:true}
  assert.deepEqual(body.response_format, { type: 'json_object' }); // json_schema é 400 na DeepSeek
  assert.equal(body.model, 'deepseek-v4-flash'); // slug OR → id direto
  assert.ok(Math.abs(cost - 0.42) < 1e-9); // custo local: 0.14 input + 0.28 output
  assert.deepEqual(out, { relation: 'direct', kind: 'news' });
});

test('callJSON: effort "max" rebaixa p/ xhigh (OpenRouter) e 401 lança KeyInvalidError provider-aware', async () => {
  const calls = mockFetch(() => ({ status: 401, ok: false, headers: { get: () => null }, json: async () => ({}) }));
  const u = 'u';
  await assert.rejects(
    callJSON({ provider: 'deepseek', apiKey: 'x', model: 'm', effort: 'max', schemaName: 's', schema: {}, user: u }),
    (e) => e instanceof KeyInvalidError && e.code === 'KEY_INVALID' && e.status === 401 && /DeepSeek/.test(e.message),
  );
  // o guard de 'max' roda ANTES do fetch; com OR o corpo deve trazer xhigh
  const calls2 = mockFetch(() => okRes(completion('{"a":1}', {}, 0.001)));
  const out = await callJSON({ provider: 'openrouter', apiKey: 'x', model: 'm', effort: 'max', schemaName: 's', schema: {}, user: u });
  assert.deepEqual(out, { a: 1 });
  assert.equal(JSON.parse(calls2[0].opts.body).reasoning.effort, 'xhigh');
});

// ---- transporte: probeKey por provider ----

test('probeKey: deepseek valida em GET /models; openrouter em GET /key', async () => {
  const calls = mockFetch(() => ({ status: 200, ok: true, json: async () => ({}) }));
  assert.deepEqual(await probeKey('sk-ds-x', 'deepseek'), { ok: true, status: 200 });
  assert.ok(calls[0].url === 'https://api.deepseek.com/models');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer sk-ds-x');
  assert.deepEqual(await probeKey('sk-or-x', 'openrouter'), { ok: true, status: 200 });
  assert.ok(calls[1].url === 'https://openrouter.ai/api/v1/key');
  assert.deepEqual(await probeKey('sk-or-x'), { ok: true, status: 200 }); // default = openrouter
  assert.ok(calls[2].url === 'https://openrouter.ai/api/v1/key');
});

test('probeKey: 401 = chave inválida; chave vazia e erro de rede não derrubam', async () => {
  mockFetch(() => ({ status: 401, ok: false, json: async () => ({}) }));
  assert.deepEqual(await probeKey('bad', 'deepseek'), { ok: false, status: 401 });
  assert.deepEqual(await probeKey('', 'deepseek'), { ok: false, status: 0, reason: 'chave vazia' });
  mockFetch(() => { throw new TypeError('fetch failed'); });
  const r = await probeKey('x', 'deepseek');
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.ok(r.reason);
});
