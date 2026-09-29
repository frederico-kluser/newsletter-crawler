// Transporte da Decisions API do Jev (OpenRouter `POST /api/alpha/decisions`) — NUNCA chat.
// Contrato de request/response e limites vêm do jev-core (fonte única, espelho isomórfico de
// src/shared/jev-core.js). O transporte é INJETÁVEL (shape do dublê test/helpers/jev-double.js)
// para os testes correrem offline.
import {
  JEV_LIMITS,
  RETRYABLE,
  anchorUntrusted,
  band,
  estimateTokens,
  injectionNoul,
  noul,
  parseAnswers,
  pOf,
  questionTokens,
  validateJevRequest,
} from '../../src/shared/jev-core.js';
import { httpTransport, sleep } from './http.js';
import { warn } from './log.js';

export class JevHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'JevHttpError';
    this.status = status;
  }
}

const MAX_INPUT_CHARS = 800; // o input do usuário nas instructions — clipado p/ não inchar o batch

/**
 * Uma decisão Jev: {model, state, questions} → answers tipadas + usage (custo real da OpenRouter).
 * Retry em 429/5xx honrando Retry-After; 400/401/402/403/404/413/422 são TERMINAIS.
 */
export async function jevDecide({
  state,
  questions,
  model,
  apiKey,
  baseUrl,
  transport = httpTransport,
  timeoutMs = 30000,
  maxAttempts = 4,
}) {
  const check = validateJevRequest({ state, questions }, { lint: true });
  if (!check.ok) {
    throw new Error(`pedido Jev inválido: ${check.errors.map((e) => `${e.where}: ${e.message}`).join('; ')}`);
  }
  for (const w of check.warnings) warn(`jev validate: ${w.where} — ${w.message}`);
  if (!apiKey) throw new JevHttpError(401, 'sem OPENROUTER_API_KEY no backend');

  const body = JSON.stringify({ model, state, questions });
  let attempt = 0;
  for (;;) {
    attempt++;
    const res = await transport({
      url: baseUrl,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'user-agent': 'newsletter-crawler-admin/1.0',
      },
      body,
      timeoutMs,
    });
    if (res.statusCode === 200) {
      let json;
      try {
        json = JSON.parse(res.body);
      } catch {
        throw new JevHttpError(502, 'resposta do Jev não é JSON');
      }
      return {
        model: json.model || model,
        provider: json.provider || null,
        answers: parseAnswers(questions, json),
        usage: normalizeUsage(json.usage),
      };
    }
    const message = String(res.body || '').slice(0, 300);
    if (!RETRYABLE.has(res.statusCode) || attempt >= maxAttempts) {
      throw new JevHttpError(res.statusCode, message || `HTTP ${res.statusCode}`);
    }
    const ra = Number(res.headers?.['retry-after']);
    const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30000) : 800 * 2 ** (attempt - 1);
    warn(`jev HTTP ${res.statusCode} (tentativa ${attempt}/${maxAttempts}) — retry em ${waitMs}ms`);
    await sleep(waitMs);
  }
}

function normalizeUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  return {
    inputTokens: Number(u.input_tokens) || 0,
    outputTokens: Number(u.output_tokens) || 0,
    cost: Number(u.cost) || 0,
  };
}

/** state do batch: artigos condensados e numerados (#1..#n) — contexto enxuto (anti "context rot"). */
export function buildBatchState(items) {
  return {
    articles: items.map((a, i) => ({
      n: i + 1,
      title: String(a.title || '').slice(0, 300),
      title_pt: String(a.title_pt || '').slice(0, 300),
      summary: String(a.summary_pt || a.snippet || a.blurb || '').slice(0, 600),
    })),
  };
}

/**
 * 1 pergunta `noul` atómica por artigo (relevância vs. o input do usuário) + a guarda de injeção
 * por request (estado = conteúdo web não confiável → âncora UNTRUSTED em todas as questions).
 */
export function buildBatchQuestions(input, count) {
  const interest = String(input || '').trim().slice(0, MAX_INPUT_CHARS);
  const questions = {};
  for (let i = 1; i <= count; i++) {
    questions[`q${i}`] = noul(`Does article #${i} match the user's interest? User interest: "${interest}"`, {
      true: "The article's main subject is about the user's interest.",
      false: "The article is unrelated to the user's interest, or only tangentially related.",
    });
  }
  questions.injection = injectionNoul();
  return anchorUntrusted(questions);
}

/** Orçamento de um batch: state + maior pergunta ≤ STATE_PLUS_LONGEST_Q × SAFETY. */
export function batchBudgetLeft(state, questions) {
  const qTokens = Object.entries(questions).reduce((acc, [id, q]) => Math.max(acc, questionTokens(id, q)), 0);
  const limit = JEV_LIMITS.STATE_PLUS_LONGEST_Q * JEV_LIMITS.SAFETY;
  return limit - estimateTokens(state) - qTokens;
}

/** Resumo da decisão por artigo: {p, decision} a partir das answers parseadas. */
export function verdictFor(parsed, questionId, threshold) {
  const ans = parsed[questionId];
  const p = ans ? pOf(ans) : null;
  return { p, decision: p == null ? 'uncertain' : band(p, threshold) };
}
