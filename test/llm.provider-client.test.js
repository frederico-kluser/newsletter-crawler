// Integração dos caminhos provider-aware do llm.js SEM rede: o `create` do SDK openai é
// substituído por um mock no PROTÓTIPO (client() só é preguiçoso — importar llm.js não cria
// instância). Como llm.js e este arquivo importam o MESMO módulo 'openai' no mesmo processo,
// o mock cobre os clients reais que o client() constrói; `this._client` de cada chamada expõe
// o client (baseURL/apiKey/maxRetries/timeout/_options.defaultHeaders) p/ verificar o cache e
// os headers por provider. O transporte (createOnce) NÃO é exportado: tudo entra por callJSON
// (a única porta pública), com retries=0 p/ forçar admissão única. O custo injetado (deepseek)
// é verificado no LEDGER real (budget.js, singleton com persist no SQLite do NC_HOME
// temporário). Processo isolado: LLM_PROVIDER=deepseek + DEEPSEEK_API_KEY antes do import.
// ZERO chamadas de rede.
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import OpenAI from 'openai'; // mesma instância de módulo que src/llm.js usa
import { setLogSink } from '../src/util.js';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-llm-client-'));
process.env.NC_HOME = NC_HOME_TMP;
for (const k of Object.keys(process.env)) {
  // Env limpo: nada do shell/usuário pode vazar p/ a resolução (mesmo padrão dos outros testes).
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) {
    delete process.env[k];
  }
}
process.env.LLM_PROVIDER = 'deepseek'; // o arquivo inteiro exercita o provider DIRETO
process.env.DEEPSEEK_API_KEY = 'sk-ds-a';
process.on('exit', () => rmSync(NC_HOME_TMP, { recursive: true, force: true }));

const config = await import('../src/config.js');
const llm = await import('../src/llm.js');
const { getBudgetState } = await import('../src/budget.js');

// ---- mock do SDK: intercepta `chat.completions.create` e grava body/options/client ----
const Completions = OpenAI.Chat.Completions;
const calls = []; // { body, options, client }
let createImpl = async () => ({
  model: 'deepseek-v4-flash',
  usage: { prompt_tokens: 10, completion_tokens: 5 },
  choices: [{ message: { content: '{}' } }],
});
mock.method(Completions.prototype, 'create', async function createMock(body, options) {
  calls.push({ body, options, client: this._client });
  return createImpl();
});

const flashUsage = (prompt = 10, completion = 5) => ({ prompt_tokens: prompt, completion_tokens: completion });
// args no formato do callJSON (a porta pública do transporte); retries=0 = admissão única.
const jsonArgs = (over = {}) => ({
  model: 'deepseek-v4-flash',
  reasoning: { effort: 'xhigh' },
  schemaName: 's',
  schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  system: 'sys',
  user: 'oi',
  retries: 0,
  fallbackModel: null,
  ...over,
});
const spentDelta = (before) => getBudgetState().spentUsd - before;

after(() => {
  mock.restoreAll();
  setLogSink(null);
  config.setRuntimeKey('sk-ds-a', 'deepseek'); // deixa o estado do processo como veio
});

// ---- client(): cache por (provider, key) + config por provider ----

test('client(): recria SÓ quando provider OU key muda; baseURL/headers/transport por provider', async () => {
  calls.length = 0;

  // Mesma key + mesmo provider -> MESMO client (cache).
  await llm.callJSON(jsonArgs({ stage: 'cache1' }));
  await llm.callJSON(jsonArgs({ stage: 'cache2' }));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].client, calls[1].client, 'provider+key iguais: client cacheado (1 instância)');

  // DeepSeek direto: baseURL do provedor, SEM headers de app (HTTP-Referer/X-Title são OpenRouter-only).
  assert.equal(calls[0].client.baseURL, 'https://api.deepseek.com');
  assert.equal(calls[0].client.apiKey, 'sk-ds-a');
  assert.equal(calls[0].client.maxRetries, 1, 'maxRetries 1 do transporte');
  assert.equal(calls[0].client.timeout, 180000, 'LLM_TIMEOUT_MS default');
  assert.equal(calls[0].client._options.defaultHeaders, undefined, 'sem headers de app no deepseek');

  // Key muda -> recria.
  config.setRuntimeKey('sk-ds-b', 'deepseek');
  await llm.callJSON(jsonArgs({ stage: 'cache3' }));
  assert.notEqual(calls[2].client, calls[0].client, 'key mudou: client recriado');
  assert.equal(calls[2].client.apiKey, 'sk-ds-b');

  // Provider muda -> recria com headers de app e baseURL do OpenRouter.
  config.setRuntimeKey('sk-or-c', 'openrouter');
  await llm.callJSON(jsonArgs({ stage: 'cache4', model: 'deepseek/deepseek-v4-flash-0731' }));
  const orClient = calls[3].client;
  assert.notEqual(orClient, calls[2].client, 'provider mudou: client recriado');
  assert.equal(orClient.baseURL, 'https://openrouter.ai/api/v1');
  assert.equal(orClient.apiKey, 'sk-or-c');
  assert.deepEqual(orClient._options.defaultHeaders, {
    'HTTP-Referer': 'https://example.com',
    'X-Title': 'NewsletterArchiver',
  });

  // Volta p/ deepseek com a key anterior -> recria (o cache é (provider,key): a ida ao
  // openrouter invalidou o client antigo, mesmo com a MESMA key de antes).
  config.setRuntimeKey('sk-ds-b', 'deepseek');
  await llm.callJSON(jsonArgs({ stage: 'cache5' }));
  assert.notEqual(calls[4].client, orClient, 'provider voltou: recria');
  assert.notEqual(calls[4].client, calls[2].client, 'key igual mas provider trocou: instância nova');
  assert.equal(calls[4].client.baseURL, 'https://api.deepseek.com');
});

// ---- transporte deepseek: body provider-aware + custo local injetado no ledger ----

test('createOnce deepseek (via callJSON): body SEM reasoning/usage.include; custo local no ledger', async () => {
  calls.length = 0;
  createImpl = async () => ({
    model: 'deepseek-v4-flash',
    usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 }, // custo esperado = US$0.28
    choices: [{ message: { content: JSON.stringify({}) } }],
  });
  const before = getBudgetState().spentUsd;
  await llm.callJSON(jsonArgs({ stage: 'costInj' }));
  const body = calls[0].body;
  assert.equal(body.model, 'deepseek-v4-flash');
  assert.equal(body.reasoning, undefined, 'reasoning (parâmetro do OpenRouter) omitido no deepseek');
  assert.equal(body.usage, undefined, 'usage.include (accounting do OpenRouter) omitido');
  assert.deepEqual(body.response_format, { type: 'json_object' }, 'json_schema não existe na API direta');
  assert.deepEqual(body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'oi' }]);
  // O custo REAL do provider não existe na resposta — o local (calculado) alimenta o ledger.
  assert.ok(Math.abs(spentDelta(before) - 0.28) < 1e-9, `custo local 1M in + 500k out = 0.28 (veio ${spentDelta(before)})`);
  assert.equal(getBudgetState().byStage.costInj.calls, 1);
  assert.ok(Math.abs(getBudgetState().byStage.costInj.costUsd - 0.28) < 1e-9);
});

test('createOnce deepseek: usage JÁ com cost não é sobrescrito (só injeta quando cost == null)', async () => {
  calls.length = 0;
  createImpl = async () => ({
    model: 'deepseek-v4-flash',
    usage: { prompt_tokens: 1_000_000, completion_tokens: 0, cost: 0.001 }, // atípico, mas presente
    choices: [{ message: { content: JSON.stringify({}) } }],
  });
  const before = getBudgetState().spentUsd;
  await llm.callJSON(jsonArgs({ stage: 'costPassthrough' }));
  assert.ok(Math.abs(spentDelta(before) - 0.001) < 1e-12, `cost do provider preservado (veio ${spentDelta(before)})`);
});

test('createOnce deepseek: usage ausente/nulo -> custo 0, sem crash (fail-open igual openrouter)', async () => {
  calls.length = 0;
  createImpl = async () => ({ model: 'deepseek-v4-flash', usage: null, choices: [{ message: { content: '{}' } }] });
  const before = getBudgetState().spentUsd;
  await llm.callJSON(jsonArgs({ stage: 'noUsage' }));
  assert.equal(spentDelta(before), 0, 'sem usage: custo registrado como 0');
  // idem com usage undefined e model ausente (usa o model do body p/ o ledger).
  calls.length = 0;
  createImpl = async () => ({ usage: undefined, choices: [{ message: { content: '{}' } }] });
  await llm.callJSON(jsonArgs({ stage: 'noUsage2' }));
  assert.equal(getBudgetState().byStage.noUsage2.calls, 1);
});

// ---- regressão openrouter: comportamento byte-idêntico ao default (LLM_PROVIDER ausente) ----

test('createOnce openrouter (regressão): body COM reasoning + usage.include; cost do provider passa direto', async () => {
  config.setRuntimeKey('sk-or-c', 'openrouter');
  calls.length = 0;
  createImpl = async () => ({
    model: 'acme/llm-probe',
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00123 },
    choices: [{ message: { content: JSON.stringify({}) } }],
  });
  const before = getBudgetState().spentUsd;
  await llm.callJSON(jsonArgs({ stage: 'orRegress', model: 'acme/llm-probe' }));
  const body = calls[0].body;
  assert.deepEqual(body.reasoning, { effort: 'xhigh' }, 'reasoning enviado no openrouter');
  assert.deepEqual(body.usage, { include: true }, 'usage accounting do OpenRouter preservado');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(calls[0].client.baseURL, 'https://openrouter.ai/api/v1');
  assert.deepEqual(calls[0].client._options.defaultHeaders, {
    'HTTP-Referer': 'https://example.com',
    'X-Title': 'NewsletterArchiver',
  });
  assert.ok(Math.abs(spentDelta(before) - 0.00123) < 1e-12, 'cost REAL do OpenRouter alimenta o ledger');
  config.setRuntimeKey('sk-ds-a', 'deepseek');
});

// ---- bordas do transporte ----

test('sem chave do provider ATIVO: lança com o keyVar certo (não usa a chave do outro)', async () => {
  config.setRuntimeKey('', 'deepseek');
  await assert.rejects(llm.callJSON(jsonArgs({ stage: 'nokey' })), /DEEPSEEK_API_KEY ausente: caminho LLM indisponível/);
  config.setRuntimeKey('', 'openrouter');
  await assert.rejects(
    llm.callJSON(jsonArgs({ stage: 'nokey2', model: 'deepseek/deepseek-v4-flash-0731' })),
    /OPENROUTER_API_KEY ausente: caminho LLM indisponível/,
  );
  config.setRuntimeKey('sk-ds-a', 'deepseek');
});

test('erro de transporte (500) devolve a reserva (cancel) e NÃO registra custo', async () => {
  calls.length = 0;
  createImpl = async () => {
    const e = new Error('provedor fora do ar');
    e.status = 500;
    throw e;
  };
  const before = getBudgetState().spentUsd;
  await assert.rejects(llm.callJSON(jsonArgs({ stage: 'transport' })), /provedor fora do ar/);
  assert.equal(spentDelta(before), 0, 'falha de transporte não é cobrada');
});

test('signal abortado antes da chamada rejeita com signal.reason e NÃO chama a API', async () => {
  calls.length = 0;
  const ac = new AbortController();
  ac.abort(new Error('job cancelado'));
  await assert.rejects(llm.callJSON(jsonArgs({ stage: 'aborted', signal: ac.signal })), /job cancelado/);
  assert.equal(calls.length, 0, 'nenhuma chamada ao SDK');
});

// ---- callJSON: parse defensivo + retry + guard de max + escalada ----

test('callJSON deepseek: JSON inválido na 1ª tentativa -> re-amostra no MESMO modelo e parseia', async () => {
  calls.length = 0;
  const payloads = ['texto sem json', JSON.stringify({ ok: true, n: 42 })];
  createImpl = async () => ({
    model: 'deepseek-v4-flash',
    usage: flashUsage(1, 1),
    choices: [{ message: { content: payloads.shift() } }],
  });
  const out = await llm.callJSON(jsonArgs({ retries: 2 }));
  assert.deepEqual(out, { ok: true, n: 42 });
  assert.equal(calls.length, 2, 'duas admissões (1º JSON inválido + retry)');
  for (const c of calls) {
    assert.equal(c.body.model, 'deepseek-v4-flash', 'retry no MESMO modelo (fallbackModel null)');
    assert.deepEqual(c.body.response_format, { type: 'json_object' });
    assert.equal(c.body.usage, undefined);
  }
});

test('callJSON: conteúdo com objeto embrulhado em prosa é extraído; prosa sem chaves = retry', async () => {
  // 1ª tentativa: JSON embrulhado em texto -> tryParseJSON extrai o {...} e parseia.
  calls.length = 0;
  createImpl = async () => ({
    model: 'deepseek-v4-flash',
    usage: flashUsage(1, 1),
    choices: [{ message: { content: 'Aqui vai a resposta: {"ok": true, "n": 7}. Fim.' } }],
  });
  const out = await llm.callJSON(jsonArgs({ retries: 0 }));
  assert.deepEqual(out, { ok: true, n: 7 });
  assert.equal(calls.length, 1);
  // 2ª tentativa: chaves presentes mas não-parseáveis -> desiste do extrato (cai no retry do JSON).
  calls.length = 0;
  const payloads = ['começo {chave inválida} fim', JSON.stringify({ ok: false })];
  createImpl = async () => ({
    model: 'deepseek-v4-flash',
    usage: flashUsage(1, 1),
    choices: [{ message: { content: payloads.shift() } }],
  });
  const out2 = await llm.callJSON(jsonArgs({ retries: 2 }));
  assert.deepEqual(out2, { ok: false });
  assert.equal(calls.length, 2, 'conteúdo com chaves não-parseáveis também re-amostra');
});

test('callJSON: última tentativa escala p/ fallbackModel e lança se o JSON seguir inválido', async () => {
  calls.length = 0;
  createImpl = async () => ({
    model: 'deepseek-v4-flash',
    usage: flashUsage(1, 1),
    choices: [{ message: { content: 'nem parece json' } }],
  });
  await assert.rejects(
    llm.callJSON(jsonArgs({ retries: 0, fallbackModel: 'deepseek-v4-pro' })),
    /JSON inválido retornado pelo LLM/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, 'deepseek-v4-pro', 'escalada p/ o fallback na última tentativa');
});

test('callJSON openrouter: guard de effort "max" rebaixa p/ xhigh (400 na API) e envia json_schema strict', async () => {
  config.setRuntimeKey('sk-or-c', 'openrouter');
  const warns = [];
  setLogSink((e) => warns.push(e.text));
  calls.length = 0;
  createImpl = async () => ({
    model: 'acme/llm-probe',
    usage: flashUsage(1, 1),
    choices: [{ message: { content: JSON.stringify({ a: 1 }) } }],
  });
  const schema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'], additionalProperties: false };
  const out = await llm.callJSON({
    ...jsonArgs({ model: 'acme/llm-probe', schema, schemaName: 's' }),
    reasoning: { effort: 'max' }, // rejeitado pelo DeepSeek V4 com HTTP 400
  });
  assert.deepEqual(out, { a: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.reasoning.effort, 'xhigh', 'guard rebaixa max -> xhigh');
  assert.deepEqual(calls[0].body.response_format, { type: 'json_schema', json_schema: { name: 's', strict: true, schema } });
  assert.deepEqual(calls[0].body.usage, { include: true });
  assert.ok(warns.some((w) => w.includes("effort 'max' não é suportado")), `aviso do guard (veio: ${warns.join(' | ')})`);
  setLogSink(null);
  config.setRuntimeKey('sk-ds-a', 'deepseek');
});

// ---- varredura provider-aware: TODAS as funções de etapa resolvem o slug direto e usam
// json_object com o provider deepseek (mesmo caminho de callJSON do pipeline real) ----

test('etapas do pipeline com provider deepseek: modelo DIRETO no body + response_format json_object', async () => {
  const payloadFor = {
    deriveLinkSelector: { selector: 'a.article', attribute: 'href', confidence: 0.9 },
    deriveContentSelector: { content_selector: 'article', confidence: 0.8 },
    deriveNextLink: { next_url: null, selector: null },
    extractLinksItemByItem: { links: [{ url: 'https://x.com/1', title: 'T1' }] },
    extractRoundupLinks: { links: [{ url: 'https://x.com/1', title: 'T1' }] },
    extractArticleViaLLM: { title: 'T', content: 'C', published_at: '2026-08-01' },
    curateRoundupItems: { issue_date: null, items: [{ url: 'https://x.com/2', title: 'T2', kind: 'news', section: 'Releases', blurb: null }] },
    curateLeftoverLinks: { issue_date: null, items: [{ url: 'https://x.com/3', title: 'T3', kind: 'other', section: null, blurb: 'b' }] },
    cleanArticleContent: { title: null, junk_spans: [], published_at: null },
    verifyRecordLLM: { verdict: 'ok', problems: [] },
    deriveDateSelector: { date_selector: '.date', date_attribute: 'datetime', date_regex: null, confidence: 0.7 },
    classifyFacet: { tags: ['node'], uncovered: [], confidence: 1 },
    summarizeArticle: { title_pt: 'T', summary_pt: 'S' },
    judgeRelevance: { relation: 'direct', kind: 'news' },
    judgeRelevanceBatch: { results: [{ id: 1, relation: 'direct', kind: 'news' }] },
    compileQuerySpec: { must_have: ['a'], nice_to_have: [], query_en: 'a', terms: ['a'] },
    mapQueryToFacetTags: { tags: ['x'] },
  };
  const run = {
    deriveLinkSelector: () => llm.deriveLinkSelector('<html>'),
    deriveContentSelector: () => llm.deriveContentSelector('<html>'),
    deriveNextLink: () => llm.deriveNextLink('<html>', 'https://x.com'),
    extractLinksItemByItem: () => llm.extractLinksItemByItem('<html>'),
    extractRoundupLinks: () => llm.extractRoundupLinks('<html>', 'https://x.com'),
    extractArticleViaLLM: () => llm.extractArticleViaLLM('texto'),
    curateRoundupItems: () => llm.curateRoundupItems({ markdown: '## Releases\n- a', baseUrl: 'https://x.com' }),
    curateLeftoverLinks: () => llm.curateLeftoverLinks({ pageContext: '<html>', baseUrl: 'https://x.com', leftovers: [{ url: 'https://x.com/3', anchor: 'demo' }] }),
    cleanArticleContent: () => llm.cleanArticleContent({ title: 'T', content: 'corpo' }),
    verifyRecordLLM: () => llm.verifyRecordLLM({ url: 'https://x.com/1', kind: 'news', title: 'T', blurb: 'b', content: 'c' }),
    deriveDateSelector: () => llm.deriveDateSelector('<html>', 'https://x.com'),
    classifyFacet: () => llm.classifyFacet({ facet: 'domain', system: 's', user: 'u' }),
    summarizeArticle: () => llm.summarizeArticle({ title: 'T', content: 'c' }),
    judgeRelevance: () => llm.judgeRelevance({ query: 'q', title: 'T', content: 'c', spec: { must_have: ['x'], nice_to_have: [], query_en: 'x' } }),
    judgeRelevanceBatch: () => llm.judgeRelevanceBatch({ query: 'q', items: [{ id: 1, title: 't', summary: 's' }] }),
    compileQuerySpec: () => llm.compileQuerySpec('consulta'),
    mapQueryToFacetTags: () => llm.mapQueryToFacetTags({ system: 's', user: 'u' }),
  };
  for (const [fn, payload] of Object.entries(payloadFor)) {
    calls.length = 0;
    createImpl = async () => ({
      model: 'deepseek-v4-flash',
      usage: flashUsage(1, 1),
      choices: [{ message: { content: JSON.stringify(payload) } }],
    });
    await run[fn](); // lança se o zod rejeitar o payload ou o caminho quebrar
    assert.equal(calls.length, 1, `${fn}: exatamente 1 chamada`);
    const { body } = calls[0];
    assert.equal(body.model, 'deepseek-v4-flash', `${fn}: slug OpenRouter traduzido p/ o direto no body`);
    assert.deepEqual(body.response_format, { type: 'json_object' }, `${fn}: json_object no provider deepseek`);
    assert.equal(body.usage, undefined, `${fn}: sem usage.include`);
  }
});

test('curateRoundupItems: hint por seção entra no prompt (release/tool/news/job/sponsor)', async () => {
  const payload = {
    issue_date: null,
    items: [{ url: 'https://x.com/2', title: 'T2', kind: 'news', section: 'S', blurb: null }],
  };
  const expectations = [
    ['Releases', 'kind "release"'],
    ['Code & Tools', 'kind "tool"'],
    ['In Brief', 'kind "news"'],
    ['Classifieds', 'kind "job"'],
    ['Sponsor', 'kind "sponsor"'],
    [null, null], // sem seção: sem hint
  ];
  for (const [section, tip] of expectations) {
    calls.length = 0;
    createImpl = async () => ({
      model: 'deepseek-v4-flash',
      usage: flashUsage(1, 1),
      choices: [{ message: { content: JSON.stringify(payload) } }],
    });
    await llm.curateRoundupItems({ markdown: '## S\n- a', baseUrl: 'https://x.com', section });
    assert.equal(calls.length, 1, `section=${section}`);
    const userText = calls[0].body.messages.find((m) => m.role === 'user').content;
    if (tip) assert.match(userText, new RegExp(tip.replace('(', '\\(')), `hint de «${section}» no prompt`);
    else assert.doesNotMatch(userText, /Esta parte é a seção/, 'sem seção: sem hint');
  }
});

test('buildBatchJudgePrompt: fonte única do prompt de lote (unit, exportada)', () => {
  const p = llm.buildBatchJudgePrompt({ query: 'consulta', items: [{ id: 7, title: 't', summary: 's' }] });
  assert.match(p.user, /CONSULTA: consulta/);
  assert.match(p.user, /"id":7/);
  const withSpec = llm.buildBatchJudgePrompt({
    query: 'q', items: [{ id: 1, title: 't', summary: 's' }],
    spec: { must_have: ['a'], nice_to_have: ['b'], query_en: 'q-en' },
  });
  assert.match(withSpec.user, /OBRIGATÓRIOS/);
  assert.match(withSpec.user, /CONSULTA \(EN\): q-en/);
});

// ---- 429: aviso com o provider ATIVO + retry após a janela (último — dorme ~1-4s por rodada) ----

test('429: avisa com o provider ativo ("da DeepSeek"/"do OpenRouter") e re-admite com sucesso', async () => {
  const warns = [];
  setLogSink((e) => warns.push(e.text));

  // DeepSeek: 429 na 1ª tentativa -> aviso "da DeepSeek" -> retry OK.
  config.setRuntimeKey('sk-ds-a', 'deepseek');
  calls.length = 0;
  let failOnce = true;
  createImpl = async () => {
    if (failOnce) {
      failOnce = false;
      const e = new Error('rate limit');
      e.status = 429;
      throw e;
    }
    return { model: 'deepseek-v4-flash', usage: flashUsage(1, 1), choices: [{ message: { content: '{}' } }] };
  };
  await llm.callJSON(jsonArgs({ stage: 'rlimitDs' }));
  assert.equal(calls.length, 2, '429 + retry');
  assert.ok(warns.some((w) => w.includes('429 da DeepSeek (rlimitDs)')), `aviso deepseek (veio: ${warns.join(' | ')})`);

  // OpenRouter: idem, com o rótulo do provider.
  config.setRuntimeKey('sk-or-c', 'openrouter');
  calls.length = 0;
  failOnce = true;
  createImpl = async () => {
    if (failOnce) {
      failOnce = false;
      const e = new Error('rate limit');
      e.status = 429;
      throw e;
    }
    return { model: 'acme/llm-probe', usage: flashUsage(1, 1), choices: [{ message: { content: '{}' } }] };
  };
  await llm.callJSON(jsonArgs({ stage: 'rlimitOr', model: 'acme/llm-probe' }));
  assert.equal(calls.length, 2, '429 + retry');
  assert.ok(warns.some((w) => w.includes('429 do OpenRouter (rlimitOr)')), `aviso openrouter (veio: ${warns.join(' | ')})`);

  setLogSink(null);
  config.setRuntimeKey('sk-ds-a', 'deepseek');
});
