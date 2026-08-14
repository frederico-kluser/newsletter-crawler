// Complemento de provider.test.js: comportamento PROFUNDO do transporte LLM por provider
// (openrouter|deepseek) — corpo exato por provider (headers/messages/system), retry por JSON
// inválido com ESCALAÇÃO p/ o fallbackModel, onCost por resposta (sobrevive a erro posterior),
// caminhos de erro (HTTP, json.error no corpo, 403), abort via signal, probeKey (403/erro de
// rede/timeout) e os edges de deepseekModelId/deepseekCostFromUsage/tryParseJSON. fetch mockado,
// sem rede. O teste de 429 fica POR ÚLTIMO (a penalidade módulo-level espera ~1-3s).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  callJSON, deepseekCostFromUsage, deepseekModelId, KeyInvalidError, probeKey, tryParseJSON,
} from '../src/lib/openrouter.js';

// ---- helpers de mock (mesma convenção de provider.test.js) ----

const okRes = (json, headers = null) => ({
  status: 200, ok: true,
  headers: { get: (k) => (headers ? headers[k] ?? null : null) },
  json: async () => json,
});
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
const bodyOf = (calls, i) => JSON.parse(calls[i].opts.body);
const args = (over = {}) => ({
  apiKey: 'sk-x', model: 'deepseek/deepseek-v4-flash-0731', effort: 'high',
  schemaName: 'relevance', schema: { type: 'object' }, user: 'u', provider: 'openrouter', ...over,
});

// ---- tryParseJSON (parse defensivo) ----

test('tryParseJSON: JSON válido, com cercas ```json e com texto antes/depois', () => {
  assert.deepEqual(tryParseJSON('{"a":1}'), { a: 1 });
  assert.deepEqual(tryParseJSON('```json\n{"relation":"direct"}\n```'), { relation: 'direct' });
  assert.deepEqual(tryParseJSON('Aqui vai o JSON: {"a":{"b":2}} espero que goste.'), { a: { b: 2 } });
});

test('tryParseJSON: arrays válidos passam; lixo, vazio e objeto incompleto → undefined', () => {
  assert.deepEqual(tryParseJSON('["a", 1]'), ['a', 1]);
  assert.equal(tryParseJSON('não é json'), undefined);
  assert.equal(tryParseJSON('{quebrado'), undefined);
  assert.equal(tryParseJSON('{a: 1}'), undefined); // tem chaves mas o que sobra também não parseia
  assert.equal(tryParseJSON(''), undefined);
  assert.equal(tryParseJSON(null), undefined);
  assert.equal(tryParseJSON(undefined), undefined);
});

// ---- deepseekModelId: edges do mapeamento slug → id direto ----

test('deepseekModelId: sufixo -NNNN sai com ou sem prefixo; nulos caem no default', () => {
  assert.equal(deepseekModelId('deepseek/deepseek-v4-pro-0731'), 'deepseek-v4-pro');
  assert.equal(deepseekModelId('deepseek-v4-flash-0731'), 'deepseek-v4-flash'); // sem prefixo
  assert.equal(deepseekModelId('deepseek/deepseek-v4-flash-1234'), 'deepseek-v4-flash'); // -1234 genérico
  assert.equal(deepseekModelId(null), 'deepseek-v4-flash');
  assert.equal(deepseekModelId(undefined), 'deepseek-v4-flash');
  assert.equal(deepseekModelId('deepseek/'), 'deepseek-v4-flash'); // prefixo vazio
});

test('deepseekModelId: sufixo fora do contrato -NNNN (5+ dígitos ou não-numérico) passa reto', () => {
  // o contrato é EXATO: '-' + 4 dígitos no FIM. 5 dígitos ou datas longas não casam → intactos.
  assert.equal(deepseekModelId('deepseek-v4-flash-12345'), 'deepseek-v4-flash-12345');
  assert.equal(deepseekModelId('deepseek-v4-flash-20260731'), 'deepseek-v4-flash-20260731');
  assert.equal(deepseekModelId('deepseek-v4-flash-abc'), 'deepseek-v4-flash-abc');
});

// ---- deepseekCostFromUsage: edges da tabela de preços local ----

test('deepseekCostFromUsage: prefere prompt_cache_miss_tokens quando presente (não deriva de prompt_tokens)', () => {
  const usage = { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 50_000, prompt_tokens: 1_000_000, completion_tokens: 0 };
  const c = deepseekCostFromUsage(usage, 'deepseek-v4-flash');
  assert.ok(Math.abs(c - 50_000 / 1e6 * 0.14) < 1e-12, 'ignora prompt_tokens quando o campo novo existe');
});

test('deepseekCostFromUsage: miss ausente/zerado/negativo deriva de prompt_tokens − hit (clamp ≥ 0)', () => {
  const missCost = (hit, miss) => (hit / 1e6) * 0.0028 + (miss / 1e6) * 0.14;
  // miss ausente: fallback derivado (prompt_tokens − hit)
  let c = deepseekCostFromUsage({ prompt_cache_hit_tokens: 25, prompt_tokens: 100, completion_tokens: 0 }, 'deepseek-v4-flash');
  assert.ok(Math.abs(c - missCost(25, 75)) < 1e-12);
  // miss = 0 explícito: cai no fallback (só > 0 vale)
  c = deepseekCostFromUsage({ prompt_cache_hit_tokens: 25, prompt_cache_miss_tokens: 0, prompt_tokens: 100, completion_tokens: 0 }, 'deepseek-v4-flash');
  assert.ok(Math.abs(c - missCost(25, 75)) < 1e-12);
  // miss negativo: cai no fallback
  c = deepseekCostFromUsage({ prompt_cache_hit_tokens: 25, prompt_cache_miss_tokens: -1, prompt_tokens: 100, completion_tokens: 0 }, 'deepseek-v4-flash');
  assert.ok(Math.abs(c - missCost(25, 75)) < 1e-12);
  // hit > prompt_tokens: miss clampado em 0 (nunca negativo)
  c = deepseekCostFromUsage({ prompt_cache_hit_tokens: 200, prompt_tokens: 100, completion_tokens: 0 }, 'deepseek-v4-flash');
  assert.ok(Math.abs(c - 200 / 1e6 * 0.0028) < 1e-12);
});

test('deepseekCostFromUsage: tokens em STRING são coagidos; completion ausente conta 0; modelo não-string cai na flash', () => {
  const c = deepseekCostFromUsage(
    { prompt_cache_hit_tokens: '1000000', prompt_cache_miss_tokens: '0', completion_tokens: undefined },
    'deepseek-v4-flash',
  );
  assert.ok(Math.abs(c - 0.0028) < 1e-12);
  assert.ok(Math.abs(deepseekCostFromUsage({ prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0, completion_tokens: 0 }, { x: 1 })) < 1e-12);
  assert.equal(deepseekCostFromUsage('usage', 'deepseek-v4-flash'), 0); // não-objeto → 0
});

// ---- callJSON: detalhes do corpo por provider ----

test('callJSON openrouter: manda system+user nas messages e o header X-Title de atribuição', async () => {
  const calls = mockFetch(() => okRes(completion('{"a":1}', {}, 0.001)));
  await callJSON(args({ system: 'sistema', fallbackModel: null }));
  assert.equal(calls[0].opts.headers['X-Title'], 'newsletter-acervo-web');
  const body = bodyOf(calls, 0);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'sistema' },
    { role: 'user', content: 'u' },
  ]);
});

test('callJSON deepseek: NÃO manda X-Title; system+user nas messages; modelo mapeado', async () => {
  const calls = mockFetch(() => okRes(completion('{"a":1}', { prompt_cache_miss_tokens: 0, completion_tokens: 0 })));
  await callJSON(args({ provider: 'deepseek', system: 'sistema' }));
  assert.equal(calls[0].opts.headers['X-Title'], undefined);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer sk-x');
  const body = bodyOf(calls, 0);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'sistema' },
    { role: 'user', content: 'u' },
  ]);
  assert.equal(body.model, 'deepseek-v4-flash');
});

test('callJSON: provider desconhecido cai no transporte da OpenRouter (fail-open)', async () => {
  const calls = mockFetch(() => okRes(completion('{"a":1}', {}, 0.001)));
  await callJSON(args({ provider: 'banana' }));
  assert.ok(calls[0].url.startsWith('https://openrouter.ai/api/v1/chat/completions'));
  assert.equal(calls[0].opts.headers['X-Title'], 'newsletter-acervo-web');
});

// ---- callJSON: custo (onCost) ----

test('callJSON: onCost NÃO é chamado quando o custo é 0/ausente (openrouter sem usage.cost; deepseek sem tokens)', async () => {
  let n = 0;
  mockFetch(() => okRes(completion('{"a":1}', { prompt_tokens: 1, completion_tokens: 1 }))); // sem usage.cost
  await callJSON(args({ onCost: () => n++ }));
  assert.equal(n, 0);
  mockFetch(() => okRes(completion('{"a":1}', { prompt_cache_miss_tokens: 0, completion_tokens: 0 })));
  await callJSON(args({ provider: 'deepseek', onCost: () => n++ }));
  assert.equal(n, 0, 'deepseek com usage zerado também não reporta');
});

test('callJSON: onCost recebe o custo de CADA resposta — mesmo quando a 1ª veio com JSON inválido (retry)', async () => {
  const usage1 = { prompt_cache_miss_tokens: 1_000_000, completion_tokens: 1_000_000 }; // 0.42
  const usage2 = { prompt_cache_miss_tokens: 500_000, completion_tokens: 0 }; // 0.07
  const calls = mockFetch((url, opts, i) =>
    i >= 2 ? okRes(completion('{"ok":true}', usage1)) : okRes(completion('lixo', usage2)));
  const costs = [];
  const out = await callJSON(args({ provider: 'deepseek', retries: 1, fallbackModel: null, onCost: (c) => costs.push(c) }));
  assert.deepEqual(out, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(costs.length, 2, 'uma chamada de onCost por RESPOSTA');
  assert.ok(Math.abs(costs[0] - 0.07) < 1e-9, `1ª resposta: ${costs[0]}`);
  assert.ok(Math.abs(costs[1] - 0.42) < 1e-9, `2ª resposta: ${costs[1]}`);
});

test('callJSON: onCost sobrevive a erro posterior (custo reportado antes do throw de JSON inválido)', async () => {
  const costs = [];
  mockFetch(() => okRes(completion('lixo também', { prompt_cache_miss_tokens: 1_000_000, completion_tokens: 0 })));
  await assert.rejects(
    callJSON(args({ provider: 'deepseek', retries: 1, fallbackModel: null, onCost: (c) => costs.push(c) })),
    /JSON inválido/,
  );
  assert.equal(costs.length, 2);
  assert.ok(Math.abs(costs[0] - 0.14) < 1e-9);
  assert.ok(Math.abs(costs[1] - 0.14) < 1e-9);
});

// ---- callJSON: retry com ESCALAÇÃO p/ fallbackModel na última tentativa ----

test('callJSON: JSON inválido na 1ª tentativa escala p/ fallbackModel na última (deepseek: modelo E preço do Pro)', async () => {
  const usageFlash = { prompt_cache_miss_tokens: 1_000_000, completion_tokens: 0 }; // 0.14
  const usagePro = { prompt_cache_miss_tokens: 1_000_000, completion_tokens: 1_000_000 }; // 0.435 + 0.87
  const calls = mockFetch((url, opts, i) =>
    i >= 2 ? okRes(completion('{"final":true}', usagePro)) : okRes(completion('quebrado', usageFlash)));
  const costs = [];
  const out = await callJSON(args({
    provider: 'deepseek', retries: 1, fallbackModel: 'deepseek/deepseek-v4-pro-0731', onCost: (c) => costs.push(c),
  }));
  assert.deepEqual(out, { final: true });
  assert.equal(calls.length, 2);
  assert.equal(bodyOf(calls, 0).model, 'deepseek-v4-flash', '1ª tentativa re-amostra o MESMO modelo');
  assert.equal(bodyOf(calls, 1).model, 'deepseek-v4-pro', 'última tentativa escala p/ o fallback');
  assert.ok(Math.abs(costs[0] - 0.14) < 1e-9, 'custo local da 1ª resposta (flash)');
  assert.ok(Math.abs(costs[1] - 1.305) < 1e-9, 'custo local da 2ª resposta (tarifa PRO)');
});

test('callJSON: escalação na OpenRouter manda o slug do fallback INTOCADO (sem mapeamento)', async () => {
  const calls = mockFetch((url, opts, i) => (i >= 2 ? okRes(completion('{"ok":1}', {}, 0.001)) : okRes(completion('x', {}, 0.001))));
  await callJSON(args({ retries: 1, fallbackModel: 'deepseek/deepseek-v4-pro-0731' }));
  assert.equal(bodyOf(calls, 0).model, 'deepseek/deepseek-v4-flash-0731');
  assert.equal(bodyOf(calls, 1).model, 'deepseek/deepseek-v4-pro-0731');
});

test('callJSON: todas as tentativas com JSON inválido → erro "JSON inválido retornado pelo LLM"', async () => {
  const calls = mockFetch(() => okRes(completion('nem isso', { prompt_cache_miss_tokens: 0, completion_tokens: 0 })));
  await assert.rejects(
    callJSON(args({ provider: 'deepseek', retries: 1 })),
    (e) => e instanceof Error && /JSON inválido retornado pelo LLM/.test(e.message),
  );
  assert.equal(calls.length, 2); // retries=1 → 2 tentativas
});

// ---- callJSON: caminhos de erro ----

test('callJSON: HTTP 500 → Error com .status (nome do provider no message)', async () => {
  mockFetch(() => ({ status: 500, ok: false, headers: { get: () => null }, json: async () => ({}) }));
  await assert.rejects(callJSON(args({ provider: 'deepseek' })), (e) =>
    e.status === 500 && /DeepSeek HTTP 500/.test(e.message));
});

test('callJSON: 200 com {error} no corpo (provedor indisponível) → Error com message/code', async () => {
  mockFetch(() => okRes({ error: { message: 'provedor indisponível', code: 502 } }));
  await assert.rejects(callJSON(args({ provider: 'deepseek' })), (e) =>
    e.message === 'provedor indisponível' && e.status === 502);
  mockFetch(() => okRes({ error: 'texto' })); // error sem .message
  await assert.rejects(callJSON(args({ provider: 'deepseek' })), (e) =>
    /erro do DeepSeek/.test(e.message) && e.status === 0);
});

test('callJSON: 403 lança KeyInvalidError provider-aware (os dois provedores)', async () => {
  mockFetch(() => ({ status: 403, ok: false, headers: { get: () => null }, json: async () => ({}) }));
  await assert.rejects(callJSON(args({ provider: 'deepseek' })), (e) =>
    e instanceof KeyInvalidError && e.code === 'KEY_INVALID' && e.status === 403 && /chave DeepSeek recusada/.test(e.message));
  await assert.rejects(callJSON(args({ provider: 'openrouter' })), (e) =>
    e instanceof KeyInvalidError && e.status === 403 && /chave OpenRouter recusada/.test(e.message));
});

test('callJSON: signal já abortado aborta ANTES do fetch', async () => {
  const calls = mockFetch(() => okRes(completion('{"a":1}', {}, 0.001)));
  const c = new AbortController();
  c.abort();
  await assert.rejects(callJSON(args({ signal: c.signal })), (e) => e.name === 'AbortError');
  assert.equal(calls.length, 0, 'nenhuma chamada de rede');
});

// ---- probeKey: edges ----

test('probeKey: 403 também é chave recusada; provider desconhecido cai no endpoint da OpenRouter', async () => {
  const calls = mockFetch(() => ({ status: 403, ok: false, json: async () => ({}) }));
  assert.deepEqual(await probeKey('x', 'deepseek'), { ok: false, status: 403 });
  assert.deepEqual(await probeKey('x', 'banana'), { ok: false, status: 403 });
  assert.ok(calls[1].url === 'https://openrouter.ai/api/v1/key');
});

test('probeKey: erro de rede com DOMException → {ok:false,status:0,reason} com a mensagem', async () => {
  mockFetch(() => { throw new DOMException('Failed to fetch', 'TypeError'); });
  const r = await probeKey('x', 'openrouter');
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.match(r.reason, /Failed to fetch/);
});

test('probeKey: TIMEOUT de 15s cai no mesmo fail-open (timeout de 10ms injetado — sem esperar 15s)', async () => {
  const origTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => {
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException('timeout', 'TimeoutError')), 10);
    return c.signal;
  };
  try {
    const calls = mockFetch((url, opts) =>
      new Promise((resolve, reject) => {
        // o fetch NUNCA responde; só o abort do signal resolve/rejeita
        opts.signal?.addEventListener('abort', () => reject(opts.signal.reason || new DOMException('abortado', 'AbortError')));
      }));
    const r = await probeKey('x', 'deepseek');
    assert.equal(r.ok, false);
    assert.equal(r.status, 0);
    assert.ok(r.reason, 'reason presente');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.deepseek.com/models');
  } finally {
    AbortSignal.timeout = origTimeout;
  }
});

// ---- callJSON: 429 (rate limit) — POR ÚLTIMO: a penalidade módulo-level espera o backoff real ~1-3s ----

test('callJSON: 429 → espera a penalidade e re-tenta o MESMO modelo (sucesso na 2ª)', async () => {
  const calls = mockFetch((url, opts, i) =>
    i >= 2
      ? okRes(completion('{"a":1}', {}, 0.001))
      : ({ status: 429, ok: false, headers: { get: () => null }, json: async () => ({}) }));
  const out = await callJSON(args({}));
  assert.deepEqual(out, { a: 1 });
  assert.equal(calls.length, 2);
  assert.equal(bodyOf(calls, 0).model, 'deepseek/deepseek-v4-flash-0731', '429 re-amostra o MESMO modelo (a escalação é só p/ JSON ruim)');
});

test('callJSON: abort durante a espera da penalidade 429 cancela de verdade (sem re-tentar)', async () => {
  // o 429 DESTE teste liga a penalidade; o signal aborta 50ms depois — enquanto o sleep espera
  const calls = mockFetch(() => ({ status: 429, ok: false, headers: { get: () => null }, json: async () => ({}) }));
  const c = new AbortController();
  setTimeout(() => c.abort(), 50);
  await assert.rejects(callJSON(args({ signal: c.signal })), (e) => e.name === 'AbortError');
  assert.equal(calls.length, 1, 'sem retry após o cancelamento');
});
