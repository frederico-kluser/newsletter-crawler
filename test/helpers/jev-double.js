// DUBLÊ DO JEV (Decisions API do OpenRouter, `POST /api/alpha/decisions`): um TRANSPORTE falso no
// contrato do `setJevTransport(fn)` de src/jev.js — fn({url, headers, body, timeoutMs, signal}) →
// {statusCode, headers, body: string}. Ele lê o request de verdade (model/state/questions), responde
// TODA pergunta com uma resposta do tipo certo e grava cada chamada, então o cliente real (retries,
// parse, ledger, fallback) roda inteiro sem rede e sem gastar um centavo.
//
// Formato da resposta = o da API real (capturado ao vivo; ver a skill do Jev, references/api.md):
//   noul   → { type:'noul', noul: p }                       (sem confidence: a incerteza é |p−0.5|)
//   choice → { type:'choice', choice, probabilities:{opção:p}, confidence }
//   score  → { type:'score', score: Σ(nível×p), probabilities:{'0':p,…}, legend:{'0':nível,…}, confidence }
//   corpo  → { id:'gen-dec-…', model:'typesafe/jev-1.13-20260917', provider:'TypeSafe', answers,
//              usage:{ input_tokens, output_tokens: 0, cost } }        (output é grátis no Jev)
//   erro   → HTTP n + { error: { code: n, message } }  (429 com Retry-After)
//
// Sem efeito colateral no import (o `node --test` executa test/helpers/*.js): nada de src/ é
// carregado no topo — o `install()` faz o import DINÂMICO de src/jev.js só quando chamado.
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxEnv } from './env.js';

export const JEV_DOUBLE_MODEL = 'typesafe/jev-1.13-20260917';
export const JEV_DOUBLE_PROVIDER = 'TypeSafe';
// Preço real do Jev 1.13: US$ 0,042 por MILHÃO de tokens de entrada; saída grátis.
export const JEV_PRICE_PER_TOKEN = 0.042e-6;
// Opções de escape (o contrato manda excluí-las do topK e tratá-las como incerteza).
export const ESCAPE_OPTIONS = Object.freeze(['none', 'other', 'unsure', 'unclear', 'no_match']);
// Níveis dos modos automáticos. `choice`/`score` = a CONFIDENCE declarada (a certeza do contrato);
// `top` = a probabilidade da opção escolhida — DE PROPÓSITO diferente da confidence, como na API real
// ({payments: 0.96} com confidence 0.78): um teste consegue distinguir o decisor que lê `confidence`
// do que lê `probabilities[choice]` por engano. confident: confidence 0.95 (top 0.98), noul 0.97 —
// bem acima de qualquer limiar razoável; unsure: confidence 0.3 (top pouco acima do uniforme, com
// piso 0.35 ≠ 0.3), noul 0.5 (50/50) — sempre vai ao fallback.
export const MODE_LEVELS = Object.freeze({
  confident: Object.freeze({ choice: 0.95, noul: 0.97, score: 0.95, top: 0.98 }),
  unsure: Object.freeze({ choice: 0.3, noul: 0.5, score: 0.3, top: 0.35 }),
});

// Limites que a API real devolve como 400 (validação do lado do servidor).
const CHOICE_MAX = 255;
const SCORE_MAX = 10;
const SCORE_MIN = 2;
const QUESTION_TYPES = new Set(['noul', 'choice', 'score']);

const STATUS_TEXT = {
  400: 'Bad Request: invalid decisions request',
  401: 'No auth credentials found',
  402: 'Insufficient credits',
  403: 'Forbidden',
  404: 'Model not found',
  413: 'Payload too large',
  422: 'Unprocessable request',
  429: 'Rate limit exceeded',
  500: 'Internal server error',
  502: 'Bad gateway',
  503: 'Service unavailable',
  504: 'Gateway timeout',
  524: 'Upstream timeout',
  529: 'Provider overloaded',
};

const round4 = (x) => Math.round(x * 1e4) / 1e4;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isEscapeOption = (opt) => ESCAPE_OPTIONS.includes(String(opt).toLowerCase());

function assertProbability(v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new RangeError(`jev-double: ${what} precisa ser um número em [0,1] (veio ${v})`);
  }
}

/**
 * A `confidence` da API p/ choice/score: CONCENTRAÇÃO da distribuição (1 = toda a massa numa opção,
 * 0 = uniforme), aqui 1 − H(p)/ln(n) sobre as n opções/níveis presentes (a API não publica a fórmula;
 * esta anda no mesmo sentido). NÃO é a maior probabilidade: {0.96, 0.02, 0.02} → ~0.82.
 */
export function concentration(probs) {
  const vals = Object.values(probs || {}).map((p) => (Number.isFinite(p) && p > 0 ? p : 0));
  if (vals.length <= 1) return 1;
  const tot = vals.reduce((a, b) => a + b, 0);
  if (!(tot > 0)) return 0;
  const h = vals.reduce((acc, p) => (p > 0 ? acc - (p / tot) * Math.log(p / tot) : acc), 0);
  return round4(Math.min(1, Math.max(0, 1 - h / Math.log(vals.length))));
}

// Marca (não enumerável: não vai p/ o JSON nem sobrevive a um spread) de confidence CALCULADA pelo
// builder sobre uma distribuição talvez parcial — o completeAnswer a recalcula sobre a completa.
const AUTO_CONFIDENCE = Symbol('jev-double.autoConfidence');
function withConfidence(out, confidence) {
  if (confidence !== undefined && confidence !== null) {
    assertProbability(confidence, 'confidence');
    out.confidence = confidence;
    return out;
  }
  out.confidence = concentration(out.probabilities);
  Object.defineProperty(out, AUTO_CONFIDENCE, { value: true });
  return out;
}

// ---- builders (respostas no formato da API; o transporte completa o que faltar pelo criteria) ----

/**
 * Resposta `choice`. `probabilities` pode ser um objeto parcial (o transporte espalha a massa que
 * sobra pelas opções ausentes do criteria) ou um número = p da opção escolhida. `confidence` ausente
 * = a CONCENTRAÇÃO da distribuição (ver concentration), recalculada sobre a distribuição completa
 * quando o transporte a completa — nunca a maior probabilidade.
 */
export function choice(option, probabilities, confidence) {
  if (typeof option !== 'string' || !option) throw new TypeError('jev-double: choice() exige a opção escolhida (string)');
  let probs;
  if (probabilities === undefined || probabilities === null) {
    probs = { [option]: confidence ?? MODE_LEVELS.confident.choice };
  } else if (typeof probabilities === 'number') {
    probs = { [option]: probabilities };
  } else if (isPlainObject(probabilities)) {
    probs = { ...probabilities };
  } else {
    throw new TypeError('jev-double: probabilities de choice() deve ser objeto {opção: p} ou número');
  }
  for (const [k, p] of Object.entries(probs)) assertProbability(p, `probabilities.${k}`);
  return withConfidence({ type: 'choice', choice: option, probabilities: probs }, confidence);
}

/** Resposta `noul` (probabilidade de "sim"). Sem confidence, como na API real. */
export function noul(p) {
  assertProbability(p, 'noul');
  return { type: 'noul', noul: p };
}

/**
 * Resposta `score`. `value` = posição ponderada (pode cair entre níveis); null + probabilities =
 * calcula Σ(nível×p). `legend` aceita o array de níveis do criteria ou o objeto {'0': nível}; ausente,
 * o transporte ecoa o criteria (a API real sempre ecoa).
 */
export function score(value, probabilities, confidence, legend) {
  let probs;
  if (isPlainObject(probabilities)) probs = { ...probabilities };
  else if (probabilities !== undefined && probabilities !== null) {
    throw new TypeError("jev-double: probabilities de score() deve ser objeto {'0': p, '1': p, …}");
  }
  let v = value;
  if (v === null || v === undefined) {
    if (!probs) throw new TypeError('jev-double: score() exige o valor ou as probabilities');
    v = round4(Object.entries(probs).reduce((s, [k, p]) => s + Number(k) * p, 0));
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new RangeError(`jev-double: score precisa ser número ≥ 0 (veio ${value})`);
  }
  if (!probs) probs = { [String(Math.round(v))]: confidence ?? MODE_LEVELS.confident.top };
  for (const [k, p] of Object.entries(probs)) assertProbability(p, `probabilities.${k}`);
  const out = withConfidence({ type: 'score', score: v, probabilities: probs }, confidence);
  if (Array.isArray(legend)) out.legend = Object.fromEntries(legend.map((l, i) => [String(i), l]));
  else if (isPlainObject(legend)) out.legend = { ...legend };
  return out;
}

// ---- respostas automáticas por tipo ----

const optionsOf = (q) => (isPlainObject(q?.criteria) ? Object.keys(q.criteria) : []);
// Níveis do score: a API exige ARRAY; um objeto (request errado) cai nas chaves, fail-open.
const levelsOf = (q) => (Array.isArray(q?.criteria) ? q.criteria : isPlainObject(q?.criteria) ? Object.keys(q.criteria) : []);

/** Massa da opção escolhida no modo unsure: pouco acima do uniforme (nunca uma decisão firme), ≠ da confidence. */
const unsureTop = (n) => (n <= 1 ? 1 : Math.max(MODE_LEVELS.unsure.top, Math.min(0.9, 1 / n + 0.05)));

/**
 * Completa uma resposta parcial contra a pergunta: probabilities cobrindo TODAS as opções/níveis
 * (a massa que sobra vai igualmente para as ausentes), legend ecoando o criteria no score e a
 * confidence CALCULADA pelo builder refeita sobre a distribuição completa (a declarada fica). Resposta
 * de tipo diferente do pedido passa INTACTA — é assim que um teste exercita o descarte por tipo; e
 * um objeto cru sem confidence segue SEM ela (um teste de resposta malformada precisa disso).
 */
export function completeAnswer(question, answer) {
  if (!isPlainObject(answer) || answer.type !== question?.type) return answer;
  if (answer.type === 'noul') return answer;
  const keys = answer.type === 'choice' ? optionsOf(question) : levelsOf(question).map((_, i) => String(i));
  if (!keys.length) return answer;
  const probs = { ...(isPlainObject(answer.probabilities) ? answer.probabilities : {}) };
  const missing = keys.filter((k) => !(k in probs));
  if (missing.length) {
    const used = Object.values(probs).reduce((s, p) => s + (Number.isFinite(p) ? p : 0), 0);
    const each = Math.max(0, 1 - used) / missing.length;
    for (const k of missing) probs[k] = round4(each);
  }
  const out = { ...answer, probabilities: probs };
  if (answer[AUTO_CONFIDENCE]) out.confidence = concentration(probs);
  if (answer.type === 'score' && !out.legend && Array.isArray(question.criteria)) {
    out.legend = Object.fromEntries(question.criteria.map((l, i) => [String(i), l]));
  }
  return out;
}

/** Resposta automática do tipo certo para UMA pergunta ('confident' | 'unsure'); tipo desconhecido → null. */
export function autoAnswer(question, mode = 'confident') {
  const unsure = mode === 'unsure';
  const lv = unsure ? MODE_LEVELS.unsure : MODE_LEVELS.confident;
  if (question?.type === 'noul') return noul(lv.noul);
  if (question?.type === 'choice') {
    const options = optionsOf(question);
    if (!options.length) return null;
    // confident: a 1ª opção que NÃO é escape (uma decisão firme de verdade); unsure: o escape, se
    // houver — o decide() do contrato trata escape como incerto, então o fallback é exercitado.
    const pick = unsure
      ? (options.find(isEscapeOption) ?? options[0])
      : (options.find((o) => !isEscapeOption(o)) ?? options[0]);
    const top = unsure ? unsureTop(options.length) : options.length === 1 ? 1 : lv.top;
    return completeAnswer(question, choice(pick, { [pick]: round4(top) }, lv.choice));
  }
  if (question?.type === 'score') {
    const levels = levelsOf(question);
    if (!levels.length) return null;
    const n = levels.length;
    let probs;
    if (unsure) {
      probs = Object.fromEntries(levels.map((_, i) => [String(i), round4(1 / n)]));
    } else {
      // confident = o nível MAIS ALTO da régua (o análogo do "sim" firme do noul).
      const top = { [String(n - 1)]: n === 1 ? 1 : lv.top };
      probs = completeAnswer(question, { type: 'score', probabilities: top }).probabilities;
    }
    return completeAnswer(question, score(null, probs, lv.score));
  }
  return null;
}

/**
 * Validação do lado do "servidor": o que a API real recusaria com 400. null = request aceito. Os
 * obrigatórios do DecisionsRequest (skill do Jev, references/api.md): `model` (string), `state`
 * (string | object | array — null não é um dos tipos) e `questions`; por pergunta, `instructions`
 * (string | object | array | null: null é ACEITO, ausente não). Sem estes checks, um builder que
 * perdesse o state (bug do clipState) ou as instructions passaria verde no dublê.
 */
export function validateDecisionsRequest(req) {
  if (!isPlainObject(req)) return 'body must be a JSON object';
  if (typeof req.model !== 'string' || !req.model.trim()) return 'model: required (string)';
  if (req.state === undefined || req.state === null) return 'state: required (string | object | array)';
  if (!isPlainObject(req.questions) || !Object.keys(req.questions).length) {
    return 'questions: expected a non-empty object of {id: question}';
  }
  for (const [id, q] of Object.entries(req.questions)) {
    if (!isPlainObject(q)) return `questions.${id}: expected an object`;
    if (!QUESTION_TYPES.has(q.type)) return `questions.${id}.type: expected noul|choice|score (got ${q.type})`;
    if (q.instructions === undefined) return `questions.${id}.instructions: required (string | object | array | null)`;
    if (q.type === 'choice') {
      if (!isPlainObject(q.criteria) || !Object.keys(q.criteria).length) {
        return `questions.${id}.criteria: choice requires a non-empty {option: rubric} map`;
      }
      if (Object.keys(q.criteria).length > CHOICE_MAX) {
        return `questions.${id}.criteria: at most ${CHOICE_MAX} options`;
      }
    }
    if (q.type === 'score') {
      if (!Array.isArray(q.criteria)) return `questions.${id}.criteria: score requires an ordered array of levels`;
      if (q.criteria.length < SCORE_MIN || q.criteria.length > SCORE_MAX) {
        return `questions.${id}.criteria: score requires ${SCORE_MIN}..${SCORE_MAX} levels`;
      }
    }
    if (q.type === 'noul' && q.criteria !== undefined) {
      if (!isPlainObject(q.criteria) || !('true' in q.criteria) || !('false' in q.criteria)) {
        return `questions.${id}.criteria: noul criteria requires both "true" and "false"`;
      }
    }
  }
  return null;
}

/**
 * Monta as answers de um request: auto do modo para cada id, sobrescrita por `answers` (objeto por
 * id — resposta pronta, função (question, ctx) → resposta, ou null = OMITE o id, p/ testar resposta
 * faltando — ou uma função (id, question, ctx) → resposta|undefined). Toda resposta é completada.
 */
export function buildAnswers(questions, { mode = 'confident', answers = {} } = {}, ctx = {}) {
  const out = {};
  for (const [id, q] of Object.entries(questions || {})) {
    let a;
    if (typeof answers === 'function') a = answers(id, q, ctx);
    else if (isPlainObject(answers) && Object.prototype.hasOwnProperty.call(answers, id)) {
      a = answers[id];
      if (typeof a === 'function') a = a(q, ctx);
      if (a === null) continue; // omitido de propósito
    }
    if (a === undefined) a = autoAnswer(q, mode);
    if (a === null || a === undefined) continue;
    out[id] = completeAnswer(q, a);
  }
  return out;
}

// ---- transporte ----

function abortError(signal) {
  const r = signal?.reason;
  if (r instanceof Error) return r;
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  e.code = 'ABORT_ERR';
  return e;
}

// Espelha o TimeoutError do got (code ETIMEDOUT) — é o que o transporte real lançaria.
function timeoutError(ms) {
  const e = new Error(`Timeout awaiting 'request' for ${ms}ms`);
  e.name = 'TimeoutError';
  e.code = 'ETIMEDOUT';
  return e;
}

function sleepAbortable(ms, signal, timeoutMs) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const timesOut = Number.isFinite(timeoutMs) && timeoutMs > 0 && ms > timeoutMs;
  const wait = timesOut ? timeoutMs : ms;
  if (!(wait > 0) && !timesOut) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      if (timesOut) reject(timeoutError(timeoutMs));
      else resolve();
    }, wait);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function parseBody(body) {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string' || body instanceof Uint8Array) {
    try {
      return JSON.parse(String(typeof body === 'string' ? body : Buffer.from(body).toString('utf8')));
    } catch {
      return null; // corpo ilegível → a validação responde 400, como a API
    }
  }
  return isPlainObject(body) ? body : null;
}

const rawOf = (body) => {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  try {
    return JSON.stringify(body ?? null);
  } catch {
    return '';
  }
};

function jsonResponse(statusCode, obj, headers = {}) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof obj === 'string' ? obj : JSON.stringify(obj),
  };
}

function errorResponse(status, { message, headers } = {}) {
  const base = status === 429 ? { 'retry-after': '0' } : {}; // '0': o teste de retry não dorme
  return jsonResponse(
    status,
    { error: { code: status, message: message ?? STATUS_TEXT[status] ?? `HTTP ${status}` } },
    { ...base, ...(headers || {}) },
  );
}

/**
 * Cria o transporte falso. Opções (todas também valem por passo em `transport.queue(...)`):
 * - mode: 'confident' | 'unsure' | 'error' | fn. `fn(ctx)` responde o REQUEST inteiro:
 *   ctx = { body, questions, call, index, auto(mode) → answers, answer(id, mode) → resposta }; devolve
 *   undefined (auto confident), um mapa {id: resposta} (ids ausentes recebem auto confident), ou
 *   { status, headers?, message?, answers? } para forçar um HTTP (status 200 + answers = sucesso).
 * - answers: sobrescritas por id (ver buildAnswers).
 * - status (default 429), headers, message: a resposta do modo 'error'.
 * - latencyMs: número ou fn(call) → ms; respeita `signal` (AbortError) e `timeoutMs` (TimeoutError).
 * - validate (default true): request malformado → 400, como a API real (ver validateDecisionsRequest).
 * - model / costPerToken: o modelo resolvido e o preço usados na resposta.
 *
 * O transporte ganha: calls[] ({n, url, headers, body (parseado), raw, timeoutMs, hasSignal,
 * statusCode, response, error}), lastCall, queue(...passos) (1 passo por chamada, FIFO; passo
 * { throw: err } simula erro de REDE), failNext(status, headers) e reset().
 */
export function makeJevTransport(opts = {}) {
  const calls = [];
  const pending = [];
  let seq = 0;

  function respond(parsed, raw, cfg, call) {
    const mode = cfg.mode ?? 'confident';
    if (mode === 'error') return errorResponse(cfg.status ?? 429, cfg);
    if ((cfg.validate ?? true) === true) {
      const problem = validateDecisionsRequest(parsed);
      if (problem) return errorResponse(400, { message: problem });
    }
    const questions = isPlainObject(parsed?.questions) ? parsed.questions : {};
    const ctx = {
      body: parsed,
      questions,
      call,
      index: call.n - 1,
      auto: (m = 'confident') => buildAnswers(questions, { mode: m }),
      answer: (id, m = 'confident') => autoAnswer(questions[id], m),
    };
    let answers;
    if (typeof mode === 'function') {
      const r = mode(ctx);
      if (r && typeof r.status === 'number' && r.status !== 200) return errorResponse(r.status, r);
      // `{answers: {...}}` embrulhado vs um id de pergunta literalmente chamado "answers".
      const wrapped = r && isPlainObject(r.answers) && typeof r.answers.type !== 'string';
      const custom = wrapped ? r.answers : isPlainObject(r) && typeof r.status !== 'number' ? r : {};
      answers = buildAnswers(questions, { mode: 'confident', answers: { ...(cfg.answers || {}), ...custom } }, ctx);
    } else {
      answers = buildAnswers(questions, { mode, answers: cfg.answers ?? {} }, ctx);
    }
    const inputTokens = Math.max(1, Math.ceil(raw.length / 4));
    const costPerToken = cfg.costPerToken ?? JEV_PRICE_PER_TOKEN;
    return jsonResponse(200, {
      id: `gen-dec-double-${call.n}`,
      model: cfg.model ?? JEV_DOUBLE_MODEL,
      provider: JEV_DOUBLE_PROVIDER,
      answers,
      usage: { input_tokens: inputTokens, output_tokens: 0, cost: inputTokens * costPerToken },
    });
  }

  async function transport({ url, headers, body, timeoutMs, signal } = {}) {
    const step = pending.length ? pending.shift() : null;
    const cfg = step ? { ...opts, ...step } : opts;
    const raw = rawOf(body);
    const parsed = parseBody(body);
    const call = {
      n: ++seq,
      url,
      headers: { ...(headers || {}) },
      body: parsed,
      raw,
      timeoutMs,
      hasSignal: Boolean(signal),
      statusCode: null,
      response: null,
      error: null,
    };
    calls.push(call);
    try {
      const lat = typeof cfg.latencyMs === 'function' ? cfg.latencyMs(call) : cfg.latencyMs;
      await sleepAbortable(Number(lat) || 0, signal, timeoutMs);
      if (step?.throw) throw step.throw;
      const res = respond(parsed, raw, cfg, call);
      call.statusCode = res.statusCode;
      try {
        call.response = JSON.parse(res.body);
      } catch {
        call.response = null;
      }
      return res;
    } catch (e) {
      call.error = e;
      throw e;
    }
  }

  transport.calls = calls;
  Object.defineProperty(transport, 'lastCall', { get: () => calls.at(-1) ?? null });
  transport.queue = (...steps) => {
    pending.push(...steps.map((s) => (typeof s === 'function' ? { mode: s } : s || {})));
    return transport;
  };
  transport.failNext = (status = 429, headers) => transport.queue({ mode: 'error', status, headers });
  transport.reset = () => {
    calls.length = 0;
    pending.length = 0;
    seq = 0;
    return transport;
  };
  return transport;
}

// ---- instalação no src/jev.js (W1) ----

function pointsToRealHome(dir) {
  return path.resolve(dir) === path.join(os.homedir(), '.newsletter-crawler');
}

async function loadJevModule() {
  // Checagem por EXISTÊNCIA, não pela mensagem do ERR_MODULE_NOT_FOUND: um src/jev.js que exista mas
  // importe algo faltando também cita "src/jev.js" na mensagem ("imported from …") e seria confundido.
  const jevPath = fileURLToPath(new URL('../../src/jev.js', import.meta.url));
  if (!existsSync(jevPath)) {
    throw new Error(
      'jev-double.install: src/jev.js não existe (o transporte do Jev chega na onda W1) — ' +
        'passe { module } com um objeto que tenha setJevTransport() ou espere a W1',
    );
  }
  // Importar src/jev.js alcança src/config.js, que CRIA/semeia o NC_HOME e carrega o .env dele no
  // load. Sem NC_HOME o default é a casa REAL (~/.newsletter-crawler, onde mora o crawler.db do
  // usuário) — então isola ANTES com a MESMA sandbox dos testes: NC_HOME tmp + .env semeado com as
  // chaves VAZIAS + OPENROUTER_/DEEPSEEK_/LLM_/DB_PATH/BACKUP_DIR fora do process.env. Só trocar o
  // NC_HOME deixava viva a chave REAL do shell (HAS_LLM=true: uma chamada sem dublê gastaria) e um
  // DB_PATH absoluto. A sandbox vale até o fim do processo (o módulo já carregou apontando p/ ela;
  // o tmpdir sai no exit). E recusa de vez um NC_HOME que aponte para a casa real.
  if (!process.env.NC_HOME) {
    sandboxEnv({}, { homePrefix: 'nc-jev-double-' });
  } else if (pointsToRealHome(process.env.NC_HOME)) {
    throw new Error('jev-double.install: NC_HOME aponta para a casa REAL do usuário — use sandboxEnv() antes de instalar o dublê');
  }
  return import('../../src/jev.js');
}

/**
 * Instala o transporte no src/jev.js via setJevTransport(transport). `opts.module` injeta o módulo
 * (o próprio src/jev.js já importado pelo teste, ou um falso); sem ele, o import é DINÂMICO e só
 * acontece aqui. Devolve { transport, calls, uninstall() } — uninstall volta ao transporte padrão
 * (setJevTransport(null)). O tripwire que faz o transporte padrão barrar a rede paga em teste é
 * contrato da W1 (ainda não existe): depois do uninstall, só a chave neutralizada protege.
 */
export async function install(transport, opts = {}) {
  if (typeof transport !== 'function') {
    throw new TypeError('jev-double.install: transporte precisa ser uma função (crie com makeJevTransport)');
  }
  const mod = opts.module ?? (await loadJevModule());
  if (typeof mod?.setJevTransport !== 'function') {
    throw new Error('jev-double.install: o módulo não exporta setJevTransport(fn) — contrato do src/jev.js (W1)');
  }
  mod.setJevTransport(transport);
  let done = false;
  return {
    transport,
    calls: transport.calls ?? [],
    uninstall() {
      if (done) return;
      done = true;
      mod.setJevTransport(null);
    },
  };
}
