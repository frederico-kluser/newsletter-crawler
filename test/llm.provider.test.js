// Provedor DeepSeek DIRETO (api.deepseek.com) na camada LLM: translateModel, providerInfo,
// HAS_LLM/setRuntimeKey provider-aware, computeUsageCost (custo local por token) e
// responseFormat por provider. Processo isolado (node --test roda cada arquivo num processo
// próprio): LLM_PROVIDER=deepseek + DEEPSEEK_API_KEY setadas ANTES do import dinâmico (config.js
// lê env no LOAD; o NC_HOME temporário impede vazamento do .env do usuário). ZERO chamadas de
// rede — importar llm.js não instancia o SDK openai (client() é preguiçoso) e nenhum teste chama
// a API; a troca de provider em runtime usa setRuntimeKey.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-llm-provider-'));
process.env.NC_HOME = NC_HOME_TMP; // NC_HOME/.env do tmp não existe — nada sobrescreve depois
for (const k of Object.keys(process.env)) {
  // Env limpo: nada do shell/usuário pode vazar p/ a resolução (mesmo padrão dos outros testes).
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) {
    delete process.env[k];
  }
}
process.env.LLM_PROVIDER = 'deepseek'; // o arquivo inteiro exercita o provider DIRETO
process.env.DEEPSEEK_API_KEY = 'sk-ds-teste';
process.on('exit', () => rmSync(NC_HOME_TMP, { recursive: true, force: true }));

const config = await import('../src/config.js');
const { responseFormat } = await import('../src/llm.js'); // import seguro: nenhum client criado

after(() => {
  // Estado deixa o processo como veio (o resto do arquivo roda antes).
  config.setRuntimeKey('sk-ds-teste', 'deepseek');
});

// ---- translateModel: slug OpenRouter -> id direto da API da DeepSeek ----

test('translateModel: mapeia o slug OpenRouter atual p/ o id direto da API da DeepSeek', () => {
  // Tabela embutida (api-docs.deepseek.com: ids aceitos = deepseek-v4-flash | deepseek-v4-pro).
  assert.equal(config.translateModel('deepseek/deepseek-v4-flash-0731'), 'deepseek-v4-flash');
  assert.equal(config.translateModel('deepseek/deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.equal(config.translateModel('deepseek/deepseek-v4-pro'), 'deepseek-v4-pro');
});

test('translateModel: slug sem prefixo vendor/ (já direto) passa INALTERADO', () => {
  assert.equal(config.translateModel('deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.equal(config.translateModel('deepseek-v4-flash-0731'), 'deepseek-v4-flash-0731');
  assert.equal(config.translateModel(''), '');
});

test('translateModel: slug fora da tabela passa inalterado (fail-open); DEEPSEEK_DEFAULT_MODEL muda isso', () => {
  assert.equal(config.translateModel('acme/llm-probe'), 'acme/llm-probe', 'fora da tabela: nunca adivinhar');
  process.env.DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
  assert.equal(config.translateModel('acme/llm-probe'), 'deepseek-v4-flash', 'default direto p/ slugs desconhecidos');
  assert.equal(config.translateModel('deepseek/deepseek-v4-pro'), 'deepseek-v4-pro', 'tabela ainda vence o default');
  delete process.env.DEEPSEEK_DEFAULT_MODEL;
});

test('translateModel: DEEPSEEK_MODEL_MAP (env) vence a tabela embutida; JSON inválido falha-open', () => {
  process.env.DEEPSEEK_MODEL_MAP = JSON.stringify({ 'acme/llm-probe': 'deepseek-v4-pro' });
  assert.equal(config.translateModel('acme/llm-probe'), 'deepseek-v4-pro');
  assert.equal(
    config.translateModel('deepseek/deepseek-v4-flash-0731'),
    'deepseek-v4-flash',
    'slug sem entrada no mapa segue a tabela embutida',
  );
  process.env.DEEPSEEK_MODEL_MAP = JSON.stringify({
    'deepseek/deepseek-v4-flash-0731': 'deepseek-v4-pro',
  });
  assert.equal(config.translateModel('deepseek/deepseek-v4-flash-0731'), 'deepseek-v4-pro', 'mapa sobrepõe a tabela');
  process.env.DEEPSEEK_MODEL_MAP = '{{nao-json';
  assert.equal(config.translateModel('deepseek/deepseek-v4-flash-0731'), 'deepseek-v4-flash', 'JSON quebrado: segue a tabela');
  delete process.env.DEEPSEEK_MODEL_MAP;
});

test('translateModel: identidade no provider openrouter (regra de ouro — nenhuma chamada muda)', () => {
  config.setRuntimeKey('sk-or-v1', 'openrouter');
  assert.equal(config.translateModel('deepseek/deepseek-v4-flash-0731'), 'deepseek/deepseek-v4-flash-0731');
  assert.equal(config.translateModel('acme/llm-probe'), 'acme/llm-probe');
  config.setRuntimeKey('sk-ds-teste', 'deepseek');
});

// ---- HAS_LLM / setRuntimeKey provider-aware ----

test('HAS_LLM/providerInfo: o provider ATIVO decide a chave; setRuntimeKey troca o provider', () => {
  assert.equal(config.LLM_PROVIDER, 'deepseek');
  assert.equal(config.HAS_LLM, true, 'DEEPSEEK_API_KEY setada no load -> HAS_LLM true');
  assert.deepEqual(config.providerInfo(), {
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    keyVar: 'DEEPSEEK_API_KEY',
    keyPresent: true,
  });

  // Sem a chave do provider ativo -> HAS_LLM false (a do outro provider NÃO compensa).
  config.setRuntimeKey('', 'deepseek');
  assert.equal(config.HAS_LLM, false);
  assert.equal(config.providerInfo().keyPresent, false);

  // Troca p/ openrouter com chave -> HAS_LLM true e a chave openrouter é a usada.
  config.setRuntimeKey('sk-or-v1-teste', 'openrouter');
  assert.equal(config.LLM_PROVIDER, 'openrouter');
  assert.equal(config.HAS_LLM, true);
  assert.deepEqual(config.providerInfo(), {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    keyVar: 'OPENROUTER_API_KEY',
    keyPresent: true,
  });
  assert.equal(config.OPENROUTER_API_KEY, 'sk-or-v1-teste');
  assert.equal(process.env.OPENROUTER_API_KEY, 'sk-or-v1-teste');

  // setRuntimeKey(key) SEM provider mantém o provider atual (contrato antigo intacto).
  config.setRuntimeKey('sk-or-v2');
  assert.equal(config.LLM_PROVIDER, 'openrouter');
  assert.equal(config.OPENROUTER_API_KEY, 'sk-or-v2');

  // Provider inválido clampeia p/ openrouter.
  config.setRuntimeKey('sk-or-v3', 'gemini');
  assert.equal(config.LLM_PROVIDER, 'openrouter');
  assert.equal(config.HAS_LLM, true);

  // Volta p/ deepseek com chave p/ os testes seguintes.
  config.setRuntimeKey('sk-ds-teste', 'deepseek');
});

// ---- stageModel/classifyFacetModel resolvem o slug direto no provider deepseek ----

test('stageModel/classifyFacetModel: modelo traduzido p/ o direto, efforts preservados', () => {
  // O config/models.json tem o slug OpenRouter; com provider deepseek o pipeline usa o direto.
  assert.deepEqual(config.stageModel('summarize'), { model: 'deepseek-v4-flash', effort: 'high' });
  assert.deepEqual(config.stageModel('linkSelector'), { model: 'deepseek-v4-flash', effort: 'xhigh' });
  assert.deepEqual(config.stageModel('searchBatch'), { model: 'deepseek-v4-flash', effort: 'medium' });
  assert.deepEqual(config.stageModel('stageInexistente'), { model: 'deepseek-v4-flash', effort: 'xhigh' });
  // Faceta com override (medium) e core (herda a etapa base, high).
  assert.deepEqual(config.classifyFacetModel('difficulty'), { model: 'deepseek-v4-flash', effort: 'medium' });
  assert.deepEqual(config.classifyFacetModel('domain'), { model: 'deepseek-v4-flash', effort: 'high' });
});

// ---- computeUsageCost: custo local (a API direta NÃO traz usage.cost) ----

test('computeUsageCost: tokens × preço oficial da API direta (USD por 1M)', () => {
  // deepseek-v4-flash: input US$0.14/1M, output US$0.28/1M (api-docs.deepseek.com, 13/ago/2026).
  const flash = config.computeUsageCost({ prompt_tokens: 1_000_000, completion_tokens: 500_000 }, 'deepseek-v4-flash');
  assert.ok(Math.abs(flash - 0.28) < 1e-12, `flash 1M in + 500k out = US$0.28 (veio ${flash})`);
  const pro = config.computeUsageCost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, 'deepseek-v4-pro');
  assert.ok(Math.abs(pro - 1.305) < 1e-12, `pro 1M in + 1M out = US$1.305 (veio ${pro})`);
  // Usage ausente/vazio -> custo zero (sem crash).
  assert.equal(config.computeUsageCost(undefined, 'deepseek-v4-flash'), 0);
  assert.equal(config.computeUsageCost({}, 'deepseek-v4-flash'), 0);
});

test('computeUsageCost: slug fora da tabela usa o preço genérico (base flash)', () => {
  const c = config.computeUsageCost({ prompt_tokens: 1_000_000, completion_tokens: 0 }, 'modelo-desconhecido');
  assert.ok(Math.abs(c - 0.14) < 1e-12, `genérico = flash input (veio ${c})`);
});

test('computeUsageCost: cache hit/miss cobrados pelos preços PRÓPRIOS (flash hit US$0.0028)', () => {
  // A API direta traz prompt_cache_hit_tokens/miss_tokens (prompt_tokens = hit + miss); o custo
  // local cobra hit×US$0.0028 + miss×US$0.14 + out×US$0.28 (não total × input — era ~50× maior).
  const c = config.computeUsageCost(
    { prompt_tokens: 1_000_000, completion_tokens: 500_000, prompt_cache_hit_tokens: 999_999, prompt_cache_miss_tokens: 1 },
    'deepseek-v4-flash',
  );
  const expected = (999_999 * 0.0028 + 1 * 0.14 + 500_000 * 0.28) / 1e6;
  assert.ok(Math.abs(c - expected) < 1e-12, `hit×hit + miss×miss + out×out (veio ${c}, esperado ${expected})`);
  // Contrasta com o cálculo antigo (1M prompt total × 0.14 = US$0.28): o hit dominante sai a
  // ~US$0.0028/1M, então o custo total cai para quase metade (veio 0.1428 < 0.28).
  assert.ok(c < 0.28, `cacheado ~US$0.0028/1M, não US$0.14 (veio ${c})`);
});

test('computeUsageCost: cache no PRO (hit US$0.003625) com miss + output', () => {
  const c = config.computeUsageCost(
    { prompt_tokens: 1_000_000, completion_tokens: 500_000, prompt_cache_hit_tokens: 800_000, prompt_cache_miss_tokens: 200_000 },
    'deepseek-v4-pro',
  );
  const expected = (800_000 * 0.003625 + 200_000 * 0.435 + 500_000 * 0.87) / 1e6;
  assert.ok(Math.abs(c - expected) < 1e-12, `pro: 800k hit + 200k miss + 500k out (veio ${c}, esperado ${expected})`);
});

test('computeUsageCost: fallback p/ prompt_tokens_details.cached_tokens (formato OpenRouter)', () => {
  // Sem os campos prompt_cache_* (formato do OpenRouter), cached_tokens vira o hit e o miss é
  // derivado do total (prompt_tokens - hit) — mesmo espelho do webapp deepseekCostFromUsage.
  const c = config.computeUsageCost(
    { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 900_000 } },
    'deepseek-v4-flash',
  );
  const expected = (900_000 * 0.0028 + 100_000 * 0.14) / 1e6;
  assert.ok(Math.abs(c - expected) < 1e-12, `cached_tokens conta como hit (veio ${c}, esperado ${expected})`);
});

test('computeUsageCost: usage SEM campos de cache cai no cálculo antigo (total × input)', () => {
  // Compat: respostas sem detalhes de cache continuam prompt_tokens × input + completion × output.
  const c = config.computeUsageCost(
    { prompt_tokens: 1_000_000, completion_tokens: 500_000, prompt_tokens_details: {} },
    'deepseek-v4-flash',
  );
  assert.ok(Math.abs(c - 0.28) < 1e-12, `sem cache: 1M × 0.14 + 500k × 0.28 (veio ${c})`);
});

test('computeUsageCost: override por env DEEPSEEK_PRICE_<MODEL>_INPUT_PER_M / _OUTPUT_PER_M', () => {
  process.env.DEEPSEEK_PRICE_DEEPSEEK_V4_FLASH_INPUT_PER_M = '0.10';
  process.env.DEEPSEEK_PRICE_DEEPSEEK_V4_FLASH_OUTPUT_PER_M = '0.20';
  const c = config.computeUsageCost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, 'deepseek-v4-flash');
  assert.ok(Math.abs(c - 0.30) < 1e-12, `override fino (veio ${c})`);
  delete process.env.DEEPSEEK_PRICE_DEEPSEEK_V4_FLASH_INPUT_PER_M;
  delete process.env.DEEPSEEK_PRICE_DEEPSEEK_V4_FLASH_OUTPUT_PER_M;
});

test('computeUsageCost: override por DEEPSEEK_PRICES (JSON de mapa)', () => {
  process.env.DEEPSEEK_PRICES = JSON.stringify({ 'deepseek-v4-flash': { input: 0.44, output: 1.32 } });
  const c = config.computeUsageCost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, 'deepseek-v4-flash');
  assert.ok(Math.abs(c - 1.76) < 1e-12, `DEEPSEEK_PRICES (veio ${c})`);
  process.env.DEEPSEEK_PRICES = '{{nao-json';
  const c2 = config.computeUsageCost({ prompt_tokens: 1_000_000, completion_tokens: 0 }, 'deepseek-v4-flash');
  assert.ok(Math.abs(c2 - 0.14) < 1e-12, 'JSON quebrado: tabela embutida (falha-open)');
  delete process.env.DEEPSEEK_PRICES;
});

// ---- responseFormat por provider (json_schema strict é OpenRouter-only) ----

test('responseFormat: json_schema strict no OpenRouter; json_object na DeepSeek direta', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
  // Provider ativo neste ponto do arquivo: deepseek (restaurado no teste de HAS_LLM).
  assert.deepEqual(responseFormat('teste_schema', schema), { type: 'json_object' });

  // Troca p/ openrouter em runtime -> comportamento de sempre (json_schema strict).
  config.setRuntimeKey('sk-or-v1', 'openrouter');
  assert.deepEqual(responseFormat('teste_schema', schema), {
    type: 'json_schema',
    json_schema: { name: 'teste_schema', strict: true, schema },
  });

  // Volta p/ deepseek (estado do início).
  config.setRuntimeKey('sk-ds-teste', 'deepseek');
  assert.deepEqual(responseFormat('teste_schema', schema), { type: 'json_object' });
});
