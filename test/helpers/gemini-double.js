// DUBLÊ DO GEMINI (chat via SDK `openai` apontado para o OpenRouter): substitui
// `OpenAI.Chat.Completions.prototype.create` — o MESMO ponto que os testes do llm.js já mockam
// (llm.zod-retry.test.js, llm.provider-client.test.js) — e devolve respostas no formato do OpenRouter:
// { model, choices:[{ message:{ content: JSON } }], usage:{ prompt_tokens, completion_tokens, cost } }.
// Toda chamada é gravada (body inteiro), p/ o teste conferir model / reasoning.effort /
// response_format.json_schema.strict / max_tokens / provider.require_parameters.
//
// Sem efeito colateral no import (o `node --test` executa test/helpers/*.js): o mock só é instalado
// quando `mockGemini()` é chamado. `openai` é o pacote de node_modules — a MESMA instância de módulo
// que o src/llm.js usa, então mockar o protótipo daqui vale para o client dele.
import { mock } from 'node:test';
import OpenAI from 'openai';

export const GEMINI_DOUBLE_MODEL = 'google/gemini-3.8-flash';
// Preço real do google/gemini-3.8-flash no OpenRouter (sonda de 2026-09-26): US$ 0,75/M de entrada e
// US$ 3,75/M de saída — o custo do dublê segue a mesma conta, então asserções de orçamento fazem sentido.
export const GEMINI_PRICE_IN_PER_TOKEN = 0.75e-6;
export const GEMINI_PRICE_OUT_PER_TOKEN = 3.75e-6;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const tokensOf = (s) => Math.max(1, Math.ceil(String(s ?? '').length / 4));

// Um mock por vez: dois mock.method empilhados no mesmo protótipo restauram na ordem errada e
// deixam o SDK real exposto (rede paga). Estado de MÓDULO só guardado aqui — nada roda no import.
let _active = null;

/**
 * Erro HTTP no formato do SDK (a subclasse certa por status: 400 BadRequestError, 429
 * RateLimitError…), com headers de verdade — o retry do llm.js lê `retry-after` por headers.get().
 */
export function apiError(status, message = `HTTP ${status}`, headers = {}) {
  return OpenAI.APIError.generate(status, { error: { code: status, message } }, message, new Headers(headers));
}

/** Converte o que o handler devolveu na resposta do SDK. */
function toResponse(out, body) {
  if (isPlainObject(out) && Array.isArray(out.choices)) return out; // resposta completa: passa intacta
  const content = typeof out === 'string' ? out : JSON.stringify(out === undefined ? {} : out);
  let promptText = '';
  try {
    promptText = JSON.stringify(body?.messages ?? '');
  } catch {
    promptText = '';
  }
  const promptTokens = tokensOf(promptText);
  const completionTokens = tokensOf(content);
  return {
    id: 'gen-double-gemini',
    model: body?.model || GEMINI_DOUBLE_MODEL,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      cost: promptTokens * GEMINI_PRICE_IN_PER_TOKEN + completionTokens * GEMINI_PRICE_OUT_PER_TOKEN,
    },
  };
}

/** handler | responses[] → handler único. Fila: cada chamada consome 1; esgotada, repete a última. */
function toHandler(spec) {
  if (typeof spec === 'function') return spec;
  if (Array.isArray(spec)) {
    const q = [...spec];
    const last = spec.length ? spec[spec.length - 1] : {};
    return (body, ctx) => {
      const next = q.length ? q.shift() : last;
      return typeof next === 'function' ? next(body, ctx) : next;
    };
  }
  if (spec === undefined) return () => ({});
  return () => spec; // valor fixo: toda chamada devolve o mesmo payload
}

/**
 * Instala o dublê. `spec`:
 * - função (body, { call, index, options }) → payload | string | resposta completa ({choices}) | lança;
 * - array: fila de respostas (cada item no formato acima, uma função, ou um Error — lançado, p/
 *   simular 400/429/402 do provedor; use apiError(status, msg, headers));
 * - qualquer outro valor: payload fixo.
 * Payload objeto vira `content: JSON.stringify(payload)`; string vai crua (JSON inválido de propósito).
 *
 * Devolve { calls, lastCall, mock, setHandler(spec), restore() } — calls[i] = { n, body, options,
 * client, model, messages, response, error }. restore() é idempotente.
 */
export function mockGemini(spec) {
  if (_active && OpenAI.Chat.Completions.prototype.create === _active.fn) {
    throw new Error('gemini-double: já existe um mockGemini ativo — chame restore() nele antes de criar outro');
  }
  const calls = [];
  let handler = toHandler(spec);
  const fn = mock.method(OpenAI.Chat.Completions.prototype, 'create', async function geminiDouble(body, options) {
    const call = {
      n: calls.length + 1,
      body,
      options,
      client: this?._client,
      model: body?.model,
      messages: body?.messages,
      response: null,
      error: null,
    };
    calls.push(call);
    try {
      // O SDK real rejeita na hora um signal já abortado (o abort do job cancela a chamada em voo).
      if (options?.signal?.aborted) throw new OpenAI.APIUserAbortError();
      const out = await handler(body, { call, index: call.n - 1, options });
      if (out instanceof Error) throw out;
      const resp = toResponse(out, body);
      call.response = resp;
      return resp;
    } catch (e) {
      call.error = e;
      throw e;
    }
  });

  let restored = false;
  const handle = {
    calls,
    fn,
    mock: fn.mock,
    get lastCall() {
      return calls.at(-1) ?? null;
    },
    setHandler(next) {
      handler = toHandler(next);
      return handle;
    },
    restore() {
      if (restored) return;
      restored = true;
      fn.mock.restore();
      if (_active === handle) _active = null;
    },
  };
  _active = handle;
  return handle;
}
