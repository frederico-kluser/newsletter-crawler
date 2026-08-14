// Bordas do bloco de provider do config.js no LOAD e em runtime, com provider deepseek ATIVO
// desde o import: LLM_PROVIDER case-insensitive, DEEPSEEK_BASE_URL override, HAS_LLM
// provider-aware (a chave do OUTRO provider não conta), translateModel/computeUsageCost nas
// arestas (mapas/JSONs malformados, slugs diretos, preços parciais, tokens de cache). Processo
// isolado (node --test = 1 processo por arquivo): env setado ANTES do import dinâmico.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-config-provider-'));
process.env.NC_HOME = NC_HOME_TMP;
// Semeia o NC_HOME/.env do TMP com o env do teste: no load do config.js ele é o ÚLTIMO a ser lido
// (precedência documentada: shell < .env do repo < NC_HOME/.env), então vence o .env do REPO real
// (ROOT/.env — a máquina de integração tem chaves reais lá e o loadDotEnvOverride as leria por
// cima do delete abaixo). Chave que DEVE ficar ausente entra como linha de valor vazio.
writeFileSync(
  path.join(NC_HOME_TMP, '.env'),
  'LLM_PROVIDER=DeepSeek\n' +
    'DEEPSEEK_BASE_URL=https://api.deepseek.example.com\n' +
    'OPENROUTER_API_KEY=sk-or-load\n' +
    'DEEPSEEK_API_KEY=\n',
);
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) {
    delete process.env[k];
  }
}
process.env.LLM_PROVIDER = 'DeepSeek'; // maiúscula/mistura: o load normaliza p/ minúsculas
process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.example.com'; // override do endpoint direto
process.env.OPENROUTER_API_KEY = 'sk-or-load'; // chave do OUTRO provider — NÃO conta p/ HAS_LLM
process.on('exit', () => rmSync(NC_HOME_TMP, { recursive: true, force: true }));

const config = await import('../src/config.js');

// ---- load: provider ativo resolve do env ----

test('load: LLM_PROVIDER case-insensitive, DEEPSEEK_BASE_URL override e HAS_LLM provider-aware', () => {
  assert.equal(config.LLM_PROVIDER, 'deepseek', "'DeepSeek' no env normaliza p/ 'deepseek'");
  assert.equal(config.DEEPSEEK_BASE_URL, 'https://api.deepseek.example.com', 'override do endpoint no load');
  assert.deepEqual(config.providerInfo(), {
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.example.com',
    keyVar: 'DEEPSEEK_API_KEY',
    keyPresent: false, // sem DEEPSEEK_API_KEY no load
  });
  assert.equal(config.HAS_LLM, false, 'a chave do OpenRouter NÃO compensa a ausência da do provider ativo');
  assert.equal(config.OPENROUTER_API_KEY, 'sk-or-load', 'chave do outro provider segue guardada (não é usada)');
});

// ---- setRuntimeKey: bordas de argumento ----

test('setRuntimeKey: key nula limpa; provider "" explícito clampeia p/ openrouter; process.env acompanha', () => {
  config.setRuntimeKey('sk-ds-r', 'deepseek');
  assert.equal(config.HAS_LLM, true);
  assert.equal(process.env.DEEPSEEK_API_KEY, 'sk-ds-r', 'process.env acompanha a troca');

  config.setRuntimeKey(null, 'deepseek'); // null/undefined -> chave vazia (limpa)
  assert.equal(config.DEEPSEEK_API_KEY, '');
  assert.equal(config.HAS_LLM, false);

  config.setRuntimeKey('sk-or-x', ''); // provider vazio explícito NÃO é default: clampeia p/ openrouter
  assert.equal(config.LLM_PROVIDER, 'openrouter');
  assert.equal(config.OPENROUTER_API_KEY, 'sk-or-x');
  assert.equal(config.HAS_LLM, true);

  config.setRuntimeKey('sk-ds-r', 'deepseek'); // restaura p/ os testes seguintes
  assert.equal(config.LLM_PROVIDER, 'deepseek');
});

// ---- translateModel: arestas com o provider deepseek ativo ----

test('translateModel: null/undefined -> ""; slug DIRETO nunca recebe DEEPSEEK_DEFAULT_MODEL', () => {
  assert.equal(config.translateModel(null), '');
  assert.equal(config.translateModel(undefined), '');
  process.env.DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-pro';
  // Regra do "/": sem prefixo vendor/ o slug já é direto -> inalterado, MESMO com default setado.
  assert.equal(config.translateModel('deepseek-v4-unknown'), 'deepseek-v4-unknown');
  // Com prefixo vendor/ e fora da tabela -> o default resolve.
  assert.equal(config.translateModel('acme/llm-probe'), 'deepseek-v4-pro');
  assert.equal(config.translateModel('deepseek/deepseek-v4-flash-0731'), 'deepseek-v4-flash', 'tabela vence o default');
  delete process.env.DEEPSEEK_DEFAULT_MODEL;
});

test('translateModel: DEEPSEEK_MODEL_MAP com JSON válido NÃO-objeto falha-open p/ a tabela embutida', () => {
  process.env.DEEPSEEK_MODEL_MAP = '42'; // JSON válido, mas não é objeto -> envDeepseekModelMap devolve null
  assert.equal(config.translateModel('deepseek/deepseek-v4-flash-0731'), 'deepseek-v4-flash', 'tabela embutida segue');
  assert.equal(config.translateModel('acme/llm-probe'), 'acme/llm-probe', 'fora da tabela: inalterado');
  process.env.DEEPSEEK_MODEL_MAP = JSON.stringify({ 'deepseek/deepseek-v4-flash-0731': 'deepseek-v4-pro' });
  assert.equal(config.translateModel('deepseek/deepseek-v4-flash-0731'), 'deepseek-v4-pro', 'mapa válido vence');
  delete process.env.DEEPSEEK_MODEL_MAP;
});

// ---- computeUsageCost: arestas de preço ----

test('computeUsageCost: slug com prefixo vendor/ resolve pelo nome do modelo', () => {
  const c = config.computeUsageCost({ prompt_tokens: 1_000_000, completion_tokens: 0 }, 'deepseek/deepseek-v4-flash');
  assert.ok(Math.abs(c - 0.14) < 1e-12, `vendor-prefixed usa o preço do modelo (veio ${c})`);
});

test('computeUsageCost: DEEPSEEK_PRICES com entrada não-objeto ou preço inválido cai na tabela', () => {
  process.env.DEEPSEEK_PRICES = JSON.stringify({ 'deepseek-v4-flash': 5 }); // entrada não é objeto
  let c = config.computeUsageCost({ prompt_tokens: 1_000_000, completion_tokens: 0 }, 'deepseek-v4-flash');
  assert.ok(Math.abs(c - 0.14) < 1e-12, `entrada não-objeto -> tabela (veio ${c})`);

  process.env.DEEPSEEK_PRICES = JSON.stringify({ 'deepseek-v4-flash': { input: 'abc', output: 1.32 } }); // preço NaN
  c = config.computeUsageCost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, 'deepseek-v4-flash');
  assert.ok(Math.abs(c - 0.42) < 1e-12, `preço não-numérico -> tabela 0.14+0.28 (veio ${c})`);
  delete process.env.DEEPSEEK_PRICES;
});

test('computeUsageCost: override fino só com INPUT não vale (exige os DOIS preços)', () => {
  process.env.DEEPSEEK_PRICE_DEEPSEEK_V4_FLASH_INPUT_PER_M = '0.10'; // sem _OUTPUT_
  const c = config.computeUsageCost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, 'deepseek-v4-flash');
  assert.ok(Math.abs(c - 0.42) < 1e-12, `parcial -> tabela 0.14+0.28 (veio ${c})`);
  delete process.env.DEEPSEEK_PRICE_DEEPSEEK_V4_FLASH_INPUT_PER_M;
});

test('computeUsageCost: chave de env normalizada p/ slug com pontuação (my.model-v2 -> MY_MODEL_V2)', () => {
  process.env.DEEPSEEK_PRICE_MY_MODEL_V2_INPUT_PER_M = '0.5';
  process.env.DEEPSEEK_PRICE_MY_MODEL_V2_OUTPUT_PER_M = '0.9';
  const c = config.computeUsageCost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, 'my.model-v2');
  assert.ok(Math.abs(c - 1.4) < 1e-12, `fino normalizado (veio ${c})`);
  delete process.env.DEEPSEEK_PRICE_MY_MODEL_V2_INPUT_PER_M;
  delete process.env.DEEPSEEK_PRICE_MY_MODEL_V2_OUTPUT_PER_M;
});

test('computeUsageCost: tokens de cache (hit/miss) têm preço próprio — hit×hit + miss×miss, NÃO total × input', () => {
  // A API direta traz prompt_cache_hit_tokens/miss_tokens e o cálculo local cobra cada parte pelo
  // preço dela (flash: hit US$0.0028/1M, miss US$0.14/1M) — cache NÃO sai como input.
  const c = config.computeUsageCost(
    { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_cache_hit_tokens: 999_999, prompt_cache_miss_tokens: 1 },
    'deepseek-v4-flash',
  );
  const expected = (999_999 * 0.0028 + 1 * 0.14) / 1e6;
  assert.ok(Math.abs(c - expected) < 1e-12, `cache cobrado por parte (veio ${c}, esperado ${expected})`);
  assert.ok(c < 0.003, `hit dominante custa ~US$0.0028 (não US$0.14 do total × input — veio ${c})`);
});

test('computeUsageCost: override DEEPSEEK_PRICES aceita hit; sem hit vale o da tabela', () => {
  process.env.DEEPSEEK_PRICES = JSON.stringify({ 'deepseek-v4-flash': { input: 0.44, output: 1.32, hit: 0.01 } });
  const c = config.computeUsageCost(
    { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_cache_hit_tokens: 1_000_000, prompt_cache_miss_tokens: 0 },
    'deepseek-v4-flash',
  );
  assert.ok(Math.abs(c - 0.01) < 1e-12, `hit do mapa vale (veio ${c})`);

  // Override sem hit -> o hit da tabela embutida cobre (cache não sai grátis).
  process.env.DEEPSEEK_PRICES = JSON.stringify({ 'deepseek-v4-flash': { input: 0.44, output: 1.32 } });
  const c2 = config.computeUsageCost(
    { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_cache_hit_tokens: 1_000_000, prompt_cache_miss_tokens: 0 },
    'deepseek-v4-flash',
  );
  assert.ok(Math.abs(c2 - 0.0028) < 1e-12, `hit da tabela embutida (veio ${c2})`);
  delete process.env.DEEPSEEK_PRICES;
});

test('computeUsageCost: override fino DEEPSEEK_PRICE_<MODEL>_HIT_PER_M (opcional)', () => {
  process.env.DEEPSEEK_PRICE_DEEPSEEK_V4_FLASH_INPUT_PER_M = '0.10';
  process.env.DEEPSEEK_PRICE_DEEPSEEK_V4_FLASH_OUTPUT_PER_M = '0.20';
  process.env.DEEPSEEK_PRICE_DEEPSEEK_V4_FLASH_HIT_PER_M = '0.005';
  const c = config.computeUsageCost(
    { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_cache_hit_tokens: 1_000_000, prompt_cache_miss_tokens: 0 },
    'deepseek-v4-flash',
  );
  assert.ok(Math.abs(c - 0.005) < 1e-12, `hit do override fino (veio ${c})`);
  delete process.env.DEEPSEEK_PRICE_DEEPSEEK_V4_FLASH_INPUT_PER_M;
  delete process.env.DEEPSEEK_PRICE_DEEPSEEK_V4_FLASH_OUTPUT_PER_M;
  delete process.env.DEEPSEEK_PRICE_DEEPSEEK_V4_FLASH_HIT_PER_M;
});

test('computeUsageCost: tokens não-numéricos -> 0 (fail-open)', () => {
  assert.equal(config.computeUsageCost({ prompt_tokens: 'abc', completion_tokens: null }, 'deepseek-v4-flash'), 0);
  assert.equal(config.computeUsageCost({ prompt_tokens: NaN, completion_tokens: 0 }, 'deepseek-v4-flash'), 0);
});
