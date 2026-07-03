// Transporte OpenRouter DIRETO do browser (BYOK — a chave do usuário nunca passa por servidor
// nosso; CORS é suportado pela OpenRouter). Porta do caminho de chamada de src/llm.js do CLI:
// - guard de effort: 'max' → 'xhigh' (DeepSeek V4 rejeita 'max' com 400)
// - response_format json_schema strict + tryParseJSON defensivo (strict NÃO é garantia)
// - retry re-amostrando o mesmo modelo; ESCALA p/ o Pro na última tentativa
// - penalidade 429 COMPARTILHADA (Retry-After/backoff+jitter, teto 60s), módulo-level
// - custo real via usage.cost (usage:{include:true}), entregue por callback onCost
// NÃO enviar HTTP-Referer manual: `Referer` é forbidden header no fetch (o browser já manda).
const OR_BASE = 'https://openrouter.ai/api/v1';
const LLM_TIMEOUT_MS = 180_000; // mesmo teto do CLI (LLM_TIMEOUT_MS)

export class KeyInvalidError extends Error {
  constructor(status) {
    super('chave OpenRouter recusada');
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

async function createOnce({ apiKey, model, effort, schemaName, schema, system, user, signal }) {
  await awaitPenalty(signal);
  throwIfAborted(signal);
  const timeout = AbortSignal.timeout(LLM_TIMEOUT_MS);
  const res = await fetch(`${OR_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'newsletter-acervo-web', // atribuição opcional da OpenRouter
    },
    body: JSON.stringify({
      model,
      reasoning: { effort },
      response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
      usage: { include: true }, // custo REAL na resposta (usage.cost, USD)
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (res.status === 401 || res.status === 403) throw new KeyInvalidError(res.status);
  if (!res.ok) {
    const err = new Error(`OpenRouter HTTP ${res.status}`);
    err.status = res.status;
    err.res = res;
    throw err;
  }
  const json = await res.json();
  if (json.error) {
    // a OpenRouter pode devolver 200 com {error} no corpo (ex.: provedor indisponível)
    const err = new Error(json.error.message || 'erro da OpenRouter');
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
 */
export async function callJSON({
  apiKey, model, effort, fallbackModel = null, schemaName, schema, system, user,
  signal = null, retries = 2, onCost = null,
}) {
  if (effort === 'max') effort = 'xhigh'; // DeepSeek V4 rejeita 'max' (HTTP 400)
  for (let attempt = 0; ; attempt++) {
    const isLast = attempt >= retries;
    const useModel = isLast && fallbackModel && model !== fallbackModel ? fallbackModel : model;
    const resp = await createWithRateLimitRetry({
      apiKey, model: useModel, effort, schemaName, schema, system, user, signal,
    });
    const cost = Number(resp.usage?.cost);
    if (Number.isFinite(cost) && cost > 0) onCost?.(cost);
    const parsed = tryParseJSON(resp.choices?.[0]?.message?.content ?? '');
    if (parsed !== undefined) return parsed;
    if (isLast) throw new Error('JSON inválido retornado pelo LLM');
  }
}

/** Valida a chave (GET /api/v1/key, 200 = válida) — espelho de probeOpenRouterKey (keys.js). */
export async function probeKey(apiKey) {
  if (!apiKey) return { ok: false, status: 0, reason: 'chave vazia' };
  try {
    const res = await fetch(`${OR_BASE}/key`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: res.status === 200, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, reason: e.message };
  }
}
