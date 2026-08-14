// Transporte LLM DIRETO do browser (BYOK — a chave do usuário nunca passa por servidor nosso;
// CORS é suportado pelos DOIS provedores). Cobre openrouter (default) | deepseek direto:
// - OpenRouter: https://openrouter.ai/api/v1 — porta do caminho de chamada de src/llm.js do CLI:
//   guard de effort ('max' → 'xhigh'), response_format json_schema strict, usage:{include:true}
//   traz o custo REAL (usage.cost), penalidade 429 compartilhada + probe via GET /key.
// - DeepSeek direto: https://api.deepseek.com (a API não suporta reasoning nem usage:{include}
//   — os parâmetros são IGNORADOS, não rejeitados; e json_schema devolve HTTP 400 "unavailable"
//   → usamos json_object, confirmado por probe 2026-08-13). Custo calculado LOCALMENTE (usage
//   não traz cost) por tokens × tabela de preços diretos (DEEPSEEK_PRICES). CORS do
//   api.deepseek.com responde preflight com allow-origin refletido (funciona do browser —
//   probe 2026-08-13).
// - retry re-amostrando o mesmo modelo; ESCALA p/ o Pro na última tentativa
// - penalidade 429 COMPARTILHADA (Retry-After/backoff+jitter, teto 60s), módulo-level
// NÃO enviar HTTP-Referer manual: `Referer` é forbidden header no fetch (o browser já manda).
import { noteRateLimit } from './lane.js';

const OR_BASE = 'https://openrouter.ai/api/v1';
const DS_BASE = 'https://api.deepseek.com';
const LLM_TIMEOUT_MS = 180_000; // mesmo teto do CLI (LLM_TIMEOUT_MS)

// ---- provedores: baseURL + nome exibido ----
const PROVIDERS = {
  openrouter: { base: OR_BASE, name: 'OpenRouter' },
  deepseek: { base: DS_BASE, name: 'DeepSeek' },
};
export const isDeepSeekProvider = (p) => p === 'deepseek';

export class KeyInvalidError extends Error {
  constructor(status, provider = 'OpenRouter') {
    super(`chave ${provider} recusada`);
    this.name = 'KeyInvalidError';
    this.code = 'KEY_INVALID';
    this.status = status;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason || new DOMException('abortado', 'AbortError'));
      },
      { once: true },
    );
  });

// ---- penalidade 429 compartilhada (porta de llm.js:39-65) ----
let _penaltyUntil = 0;
let _penaltyK = 0;

function retryAfterMsOf(res) {
  const ms = Number(res?.headers?.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const s = Number(res?.headers?.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? s * 1000 : 0;
}

async function awaitPenalty(signal) {
  for (;;) {
    const waitMs = _penaltyUntil - Date.now();
    if (waitMs <= 0) return;
    await sleep(Math.min(waitMs, 5000), signal); // re-checa: outro 429 pode ter estendido a janela
  }
}

function bumpPenalty(res) {
  _penaltyK = Math.min(_penaltyK + 1, 6);
  const backoff = Math.min(2 ** _penaltyK * 1000 * (0.5 + Math.random()), 60_000);
  const until = Date.now() + Math.max(retryAfterMsOf(res), backoff);
  if (until > _penaltyUntil) _penaltyUntil = until;
  noteRateLimit(); // AIMD: além do freio por TEMPO, encolhe a LARGURA da lane (igual ao governor)
}

// ---- parse defensivo (porta verbatim de llm.js tryParseJSON) ----
export function tryParseJSON(content) {
  if (!content) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    /* tenta extrair o objeto */
  }
  const m = content.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      /* desiste */
    }
  }
  return undefined;
}

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw signal.reason || new DOMException('abortado', 'AbortError');
};

// ---- DeepSeek direto: id de modelo + preço local (docs: api-docs.deepseek.com/quick_start/pricing) ----
// Slugs do snapshot (meta.search.models) são os da OpenRouter (`deepseek/deepseek-v4-flash-0731`);
// na API direta o id é `deepseek-v4-flash`/`deepseek-v4-pro` (a versão fica implícita — a DeepSeek
// roteia pro build mais novo; confirmado na doc oficial e no GET /models real).
export function deepseekModelId(slug) {
  const base = String(slug || '').replace(/^deepseek\//, '').replace(/-\d{4}$/, '');
  return base || 'deepseek-v4-flash';
}

// Preços por 1M tokens (USD) — tarifa oficial corrente (2026-08-13; a DeepSeek anunciou revisão
// de preço p/ peak/off-peak efetivo em 2026-08-16 16:00 UTC — se mudar, atualizar aqui).
const DEEPSEEK_PRICES = {
  'deepseek-v4-flash': { inputCacheHit: 0.0028, input: 0.14, output: 0.28 },
  'deepseek-v4-pro': { inputCacheHit: 0.003625, input: 0.435, output: 0.87 },
};

/**
 * Custo REAL em USD de uma resposta da DeepSeek direta (a API NÃO traz usage.cost — o OpenRouter
 * traz): tokens × tabela local. Campos de cache: prefere prompt_cache_hit/miss_tokens (novos);
 * fallback p/ prompt_tokens_details.cached_tokens. Modelo fora da tabela → tarifa flash.
 */
export function deepseekCostFromUsage(usage, modelId) {
  if (!usage || typeof usage !== 'object') return 0;
  const p = DEEPSEEK_PRICES[String(modelId || '')] || DEEPSEEK_PRICES['deepseek-v4-flash'];
  const hit = Number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens) || 0;
  const missRaw = Number(usage.prompt_cache_miss_tokens);
  const miss = Number.isFinite(missRaw) && missRaw > 0 ? missRaw : Math.max((Number(usage.prompt_tokens) || 0) - hit, 0);
  const out = Number(usage.completion_tokens) || 0;
  return (hit / 1e6) * p.inputCacheHit + (miss / 1e6) * p.input + (out / 1e6) * p.output;
}

async function createOnce({ apiKey, model, effort, schemaName, schema, system, user, signal, provider = 'openrouter' }) {
  await awaitPenalty(signal);
  throwIfAborted(signal);
  const isDs = isDeepSeekProvider(provider);
  const cfg = PROVIDERS[provider] || PROVIDERS.openrouter;
  const timeout = AbortSignal.timeout(LLM_TIMEOUT_MS);
  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(isDs ? {} : { 'X-Title': 'newsletter-acervo-web' }), // atribuição opcional da OpenRouter
    },
    body: JSON.stringify({
      model,
      // DeepSeek direto: NÃO envia reasoning nem usage:{include:true} (não suportados — a API os
      // ignora); custo local via deepseekCostFromUsage.
      ...(isDs ? {} : { reasoning: { effort } }),
      response_format: isDs
        ? { type: 'json_object' } // json_schema: HTTP 400 "unavailable" na DeepSeek (probe 2026-08-13)
        : { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
      ...(isDs ? {} : { usage: { include: true } }), // custo REAL na resposta (usage.cost, USD)
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (res.status === 401 || res.status === 403) throw new KeyInvalidError(res.status, cfg.name);
  if (!res.ok) {
    const err = new Error(`${cfg.name} HTTP ${res.status}`);
    err.status = res.status;
    err.res = res;
    throw err;
  }
  const json = await res.json();
  if (json.error) {
    // provedores podem devolver 200 com {error} no corpo (ex.: provedor indisponível)
    const err = new Error(json.error.message || `erro do ${cfg.name}`);
    err.status = json.error.code || 0;
    throw err;
  }
  return json;
}

async function createWithRateLimitRetry(args) {
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(args.signal);
    try {
      const resp = await createOnce(args);
      if (Date.now() >= _penaltyUntil) _penaltyK = 0; // janela limpa: zera o backoff
      return resp;
    } catch (e) {
      if (e?.status === 429 && attempt < 3 && !args.signal?.aborted) {
        bumpPenalty(e.res);
        continue; // re-espera a penalidade e tenta de novo
      }
      throw e;
    }
  }
}

/**
 * Chamada JSON com retry + escalação (porta de callJSON, llm.js:144-182): até `retries+1`
 * tentativas re-amostrando o MESMO modelo; na última, se difere, escala p/ `fallbackModel`
 * (Pro — mais confiável no JSON). `onCost` recebe o custo real de CADA resposta na hora
 * (sobrevive a um erro posterior). Retorna o objeto parseado.
 * `provider` = 'openrouter' (default) | 'deepseek' — muda baseURL, corpo (reasoning/usage/
 * response_format) e a fonte do custo (usage.cost da OpenRouter vs tabela local da DeepSeek).
 */
export async function callJSON({
  apiKey, model, effort, fallbackModel = null, schemaName, schema, system, user,
  signal = null, retries = 2, onCost = null, provider = 'openrouter',
}) {
  if (effort === 'max') effort = 'xhigh'; // DeepSeek V4 rejeita 'max' (HTTP 400)
  const isDs = isDeepSeekProvider(provider);
  for (let attempt = 0; ; attempt++) {
    const isLast = attempt >= retries;
    const useModel = isLast && fallbackModel && model !== fallbackModel ? fallbackModel : model;
    const resp = await createWithRateLimitRetry({
      apiKey, model: isDs ? deepseekModelId(useModel) : useModel, effort, schemaName, schema, system, user, signal, provider,
    });
    let cost = 0;
    if (isDs) {
      cost = deepseekCostFromUsage(resp.usage, deepseekModelId(useModel));
    } else {
      const c = Number(resp.usage?.cost);
      if (Number.isFinite(c) && c > 0) cost = c;
    }
    if (cost > 0) onCost?.(cost);
    const parsed = tryParseJSON(resp.choices?.[0]?.message?.content ?? '');
    if (parsed !== undefined) return parsed;
    if (isLast) throw new Error('JSON inválido retornado pelo LLM');
  }
}

/**
 * Valida a chave do provider ATIVO (200 = válida): OpenRouter → GET /api/v1/key (espelho de
 * probeOpenRouterKey, keys.js); DeepSeek direta → GET /models (401 sem/com chave inválida —
 * probe 2026-08-13). Timeout 15s.
 */
export async function probeKey(apiKey, provider = 'openrouter') {
  if (!apiKey) return { ok: false, status: 0, reason: 'chave vazia' };
  const isDs = isDeepSeekProvider(provider);
  const cfg = PROVIDERS[provider] || PROVIDERS.openrouter;
  try {
    const res = await fetch(`${cfg.base}/${isDs ? 'models' : 'key'}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: res.status === 200, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, reason: e.message };
  }
}
