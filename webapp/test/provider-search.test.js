// O MOTOR de busca (lib/search.js) recebe `provider` e repassa a TODA chamada LLM (compileSpec,
// judgeBatch, judgeOne): runSearch com provider deepseek roda 100% no https://api.deepseek.com com
// corpo json_object/sem reasoning/sem usage e custo LOCAL; openrouter (default) mantém o
// https://openrouter.ai com usage.cost. KEY_INVALID propaga; lote quebrado vira 'none' (fail-open).
// fetch mockado (sem rede); lane/pool reais (adaptativos) — mesma convenção dos testes do repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSpec, runSearch } from '../src/lib/search.js';
import { KeyInvalidError } from '../src/lib/openrouter.js';

const okRes = (json) => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => json });
const completion = (content, usage, cost) => ({
  choices: [{ message: { content } }],
  usage: cost !== undefined ? { ...usage, cost } : usage,
});
// Fila de respostas: serve responses[i] (a última se esgotar) e registra as chamadas.
function mockFetchQueue(responses) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const i = Math.min(calls.length - 1, responses.length - 1);
    return typeof responses[i] === 'function' ? responses[i](url, opts, calls.length) : responses[i];
  };
  return calls;
}

// Config p/ os DOIS provedores (idêntica ao shape de meta.search no snapshot).
const SEARCH_CFG = {
  batchSize: 40,
  maxItems: 500,
  maxChars: 8000,
  concurrency: { soft: 2, deep: 2 },
  models: {
    searchBatch: { model: 'deepseek/deepseek-v4-flash-0731', effort: 'xhigh' },
    searchRelevance: { model: 'deepseek/deepseek-v4-flash-0731', effort: 'high' },
    searchSpec: { model: 'deepseek/deepseek-v4-pro-0731', effort: 'high' },
    fallback: { model: 'deepseek/deepseek-v4-pro-0731' },
  },
};
const NO_SPEC_CFG = { ...SEARCH_CFG, models: { ...SEARCH_CFG.models, searchSpec: undefined } };

const item = (id, extra = {}) => ({ id, title: `t${id}`, summary_pt: `s${id}`, ...extra });
// terms com palavras ≥3 letras (senão o prioritizeBySpec devolve a lista sem ordenar)
const specJson = { must_have: ['a'], nice_to_have: [], query_en: 'q en', terms: ['react', 'frontend'] };
const flashUsage = { prompt_cache_miss_tokens: 1_000_000, completion_tokens: 1_000_000 }; // 0.42
const getContent = async (id) => `conteúdo completo do artigo ${id}`;

// ---- compileSpec: provider repassado ----

test('compileSpec deepseek: chama a DeepSeek com json_object e normaliza o spec', async () => {
  const calls = mockFetchQueue([okRes(completion(JSON.stringify(specJson), flashUsage))]);
  let cost = 0;
  const spec = await compileSpec({ query: 'consulta', search: SEARCH_CFG, apiKey: 'sk-ds', provider: 'deepseek', onCost: (c) => (cost += c) });
  assert.ok(calls[0].url.startsWith('https://api.deepseek.com/chat/completions'));
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.model, 'deepseek-v4-pro'); // slug do searchSpec mapeado p/ id direto
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.reasoning, undefined);
  assert.equal(body.usage, undefined);
  assert.deepEqual(spec, { must_have: ['a'], nice_to_have: [], query_en: 'q en', terms: ['react', 'frontend'] });
  assert.ok(Math.abs(cost - 1.305) < 1e-9, 'custo local com tarifa PRO (0.435+0.87) do modelo do spec');
});

test('compileSpec: default provider = openrouter; campo ausente → null sem chamada; saída inválida → null', async () => {
  const calls = mockFetchQueue([okRes(completion(JSON.stringify(specJson), {}, 0.001))]);
  const spec = await compileSpec({ query: 'q', search: SEARCH_CFG, apiKey: 'k' });
  assert.ok(calls[0].url.startsWith('https://openrouter.ai/api/v1/chat/completions'));
  assert.deepEqual(spec.must_have, ['a']);
  // snapshot antigo sem searchSpec: NULL e ZERO chamadas
  const calls2 = mockFetchQueue([okRes(completion(JSON.stringify(specJson), {}, 0.001))]);
  assert.equal(await compileSpec({ query: 'q', search: NO_SPEC_CFG, apiKey: 'k' }), null);
  assert.equal(calls2.length, 0);
  // resposta não-objeto (número) → null (fail-open)
  const calls3 = mockFetchQueue([okRes(completion('42', flashUsage))]);
  assert.equal(await compileSpec({ query: 'q', search: SEARCH_CFG, apiKey: 'k', provider: 'deepseek' }), null);
  assert.equal(calls3.length, 1);
});

// ---- runSearch soft (lote) com provider deepseek: corpo, custo local, hits, progresso ----

test('runSearch soft deepseek: spec + lote na DeepSeek, custo LOCAL acumulado e hits direct-first', async () => {
  const calls = mockFetchQueue([
    okRes(completion(JSON.stringify(specJson), flashUsage)), // spec (pro)
    okRes(completion(JSON.stringify({ results: [{ id: 1, relation: 'direct', kind: 'news' }, { id: 3, relation: 'similar', kind: 'tool' }] }), flashUsage)), // lote
  ]);
  const progress = [];
  const hits = [];
  const specs = [];
  const candidates = [item(1), item(2, { title: '', summary_pt: '' }), item(3)]; // id 2: sem texto → 'none' local
  const r = await runSearch({
    query: 'q', deep: false, candidates, search: SEARCH_CFG, apiKey: 'sk-ds', provider: 'deepseek',
    onProgress: (p) => progress.push(p), onHit: (h) => hits.push(h), onSpec: (s) => specs.push(s),
  });
  assert.equal(calls.length, 2, 'spec + 1 lote');
  for (const c of calls) {
    assert.ok(c.url.startsWith('https://api.deepseek.com/chat/completions'));
    const body = JSON.parse(c.opts.body);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.reasoning, undefined);
    assert.equal(body.usage, undefined);
  }
  assert.equal(JSON.parse(calls[0].opts.body).model, 'deepseek-v4-pro', 'spec usa o modelo Pro direto');
  assert.equal(JSON.parse(calls[1].opts.body).model, 'deepseek-v4-flash', 'lote usa o Flash direto');
  assert.deepEqual(specs, [specJson]);
  assert.equal(r.scanned, 3);
  assert.equal(r.total, 3);
  assert.equal(r.relevant, 2);
  assert.equal(r.failed, 0);
  assert.deepEqual(r.hits, [
    { id: 1, relation: 'direct', kind: 'news' },
    { id: 3, relation: 'similar', kind: 'tool' },
  ], 'direct primeiro, similar depois (id desc)');
  assert.ok(Math.abs(r.spentUsd - (1.305 + 0.42)) < 1e-9, 'spec (tarifa PRO 1.305) + lote (flash 0.42)');
  assert.equal(hits.length, 2);
  assert.ok(progress.length >= 2);
  assert.equal(progress.at(-1).done, 3);
  assert.equal(progress.at(-1).mode, 'soft');
  // o lote NÃO enviou o item sem título/resumo (gasto zero nele)
  assert.ok(!JSON.parse(calls[1].opts.body).messages[1].content.includes('"id":2'), 'id 2 não vai à API');
});

test('runSearch soft sem provider explícito: OpenRouter default com usage.cost (slug intocado)', async () => {
  const calls = mockFetchQueue([okRes(completion(JSON.stringify({ results: [{ id: 7, relation: 'direct', kind: 'tool' }] }), {}, 0.00123))]);
  const r = await runSearch({
    query: 'q', deep: false, candidates: [item(7)], search: NO_SPEC_CFG, apiKey: 'sk-or',
  });
  assert.ok(calls[0].url.startsWith('https://openrouter.ai/api/v1/chat/completions'));
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.model, 'deepseek/deepseek-v4-flash-0731', 'slug da OpenRouter INTOCADO no OR');
  assert.equal(body.reasoning.effort, 'xhigh');
  assert.deepEqual(body.usage, { include: true });
  assert.deepEqual(body.response_format.type, 'json_schema');
  assert.equal(calls[0].opts.headers['X-Title'], 'newsletter-acervo-web');
  assert.ok(Math.abs(r.spentUsd - 0.00123) < 1e-9, 'custo REAL do usage.cost');
  assert.deepEqual(r.hits, [{ id: 7, relation: 'direct', kind: 'tool' }]);
});

test('runSearch soft: lote quebrado vira "none" e conta em failed (fail-open, busca não derruba)', async () => {
  mockFetchQueue([() => { throw new TypeError('fetch failed'); }]);
  const r = await runSearch({
    query: 'q', deep: false, candidates: [item(1), item(2)], search: NO_SPEC_CFG, apiKey: 'k', provider: 'deepseek',
  });
  assert.equal(r.scanned, 2);
  assert.equal(r.failed, 2);
  assert.equal(r.relevant, 0);
  assert.deepEqual(r.hits, []);
});

test('runSearch: KEY_INVALID (401) PROPAGA do lote (o hook reabre o KeyModal com a busca pendente)', async () => {
  mockFetchQueue([{ status: 401, ok: false, headers: { get: () => null }, json: async () => ({}) }]);
  await assert.rejects(
    runSearch({ query: 'q', deep: false, candidates: [item(1)], search: NO_SPEC_CFG, apiKey: 'bad', provider: 'deepseek' }),
    (e) => e instanceof KeyInvalidError && e.code === 'KEY_INVALID' && e.status === 401 && /DeepSeek/.test(e.message),
  );
});

test('runSearch: KEY_INVALID PROPAGA do spec (1ª chamada Pro) com provider deepseek', async () => {
  mockFetchQueue([{ status: 403, ok: false, headers: { get: () => null }, json: async () => ({}) }]);
  await assert.rejects(
    runSearch({ query: 'q', deep: false, candidates: [item(1)], search: SEARCH_CFG, apiKey: 'bad', provider: 'deepseek' }),
    (e) => e.code === 'KEY_INVALID' && e.status === 403,
  );
});

test('runSearch: candidatos vazios → resultado zerado SEM nenhuma chamada', async () => {
  const calls = mockFetchQueue([okRes(completion('{}', flashUsage))]);
  const r = await runSearch({ query: 'q', deep: false, candidates: [], search: SEARCH_CFG, apiKey: 'k', provider: 'deepseek' });
  assert.equal(calls.length, 0);
  assert.deepEqual(r.hits, []);
  assert.equal(r.scanned, 0);
});

// ---- runSearch profunda (1 chamada por artigo) com provider ----

test('runSearch deep deepseek: judgeOne por artigo com getContent, clamp e custo local por resposta', async () => {
  const calls = mockFetchQueue([
    okRes(completion(JSON.stringify(specJson), flashUsage)), // spec
    okRes(completion(JSON.stringify({ relation: 'direct', kind: 'tool' }), flashUsage)), // artigo 1
    okRes(completion(JSON.stringify({ relation: 'banana', kind: 'banana' }), flashUsage)), // artigo 2 → clamps
  ]);
  const r = await runSearch({
    query: 'q', deep: true, candidates: [item(1), item(2)], search: SEARCH_CFG, apiKey: 'sk-ds',
    provider: 'deepseek', getContent,
  });
  assert.equal(calls.length, 3, 'spec + 1 por artigo');
  const judgeBodies = calls.slice(1).map((c) => JSON.parse(c.opts.body));
  for (const b of judgeBodies) {
    assert.equal(b.model, 'deepseek-v4-flash');
    assert.deepEqual(b.response_format, { type: 'json_object' });
    assert.ok(b.messages[1].content.includes('conteúdo completo do artigo'), 'conteúdo real do getContent no prompt');
  }
  assert.equal(r.scanned, 2);
  assert.equal(r.relevant, 1);
  assert.deepEqual(r.hits, [{ id: 1, relation: 'direct', kind: 'tool' }]);
  assert.ok(Math.abs(r.spentUsd - (1.305 + 0.42 * 2)) < 1e-9, 'spec (PRO) + 2 artigos (flash)');
});

test('runSearch deep: juiz de UM artigo quebrado vira "none" e conta em failed (fail-open por artigo)', async () => {
  const calls = mockFetchQueue([
    okRes(completion(JSON.stringify(specJson), flashUsage)), // spec
    okRes(completion(JSON.stringify({ relation: 'direct', kind: 'tool' }), flashUsage)), // artigo 1
    () => { throw new TypeError('fetch failed'); }, // artigo 2 quebra
  ]);
  const r = await runSearch({
    query: 'q', deep: true, candidates: [item(1), item(2)], search: SEARCH_CFG, apiKey: 'sk-ds',
    provider: 'deepseek', getContent,
  });
  assert.equal(calls.length, 3);
  assert.equal(r.scanned, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.relevant, 1);
  assert.deepEqual(r.hits, [{ id: 1, relation: 'direct', kind: 'tool' }], 'o artigo bom sobrevive ao irmão quebrado');
  assert.ok(Math.abs(r.spentUsd - (1.305 + 0.42)) < 1e-9, 'só o spec e o artigo 1 custam');
});

// ---- retomada com provider: espec não repaga; custo semeado soma ----

test('runSearch retomada deepseek: pula o já julgado, NÃO re-chama o spec e soma o custo semeado', async () => {
  const calls = mockFetchQueue([okRes(completion(JSON.stringify({ results: [{ id: 2, relation: 'similar', kind: 'news' }] }), flashUsage))]);
  const resume = {
    judgedIds: [1], hits: [{ id: 1, relation: 'direct', kind: 'news' }],
    scanned: 1, failed: 0, spentUsd: 0.01, total: 2, spec: specJson,
  };
  const r = await runSearch({
    query: 'q', deep: false, candidates: [item(1), item(2)], search: SEARCH_CFG, apiKey: 'sk-ds',
    provider: 'deepseek', resume,
  });
  assert.equal(calls.length, 1, 'só o lote do artigo 2 (spec veio do checkpoint)');
  assert.equal(r.scanned, 2);
  assert.equal(r.total, 2);
  assert.equal(r.failed, 0);
  assert.equal(r.relevant, 2);
  assert.ok(Math.abs(r.spentUsd - 0.01 - 0.42) < 1e-9, 'custo semeado + lote novo');
  assert.deepEqual(r.hits, [
    { id: 1, relation: 'direct', kind: 'news' }, // do checkpoint, direct 1º
    { id: 2, relation: 'similar', kind: 'news' },
  ]);
});
