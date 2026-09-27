// Limitação de taxa POR LANE, reutilizável: (1) JANELA DE PENALIDADE de 429 — um timestamp
// COMPARTILHADO por todas as chamadas da lane (um 429 de qualquer uma segura TODAS as admissões
// novas até a janela abrir: Retry-After do provedor ou backoff exponencial com jitter, teto 60s)
// e (2) PORTÃO DE REQUISIÇÕES POR SEGUNDO (GCRA / espaçamento mínimo entre admissões).
// Extraído do padrão de src/llm.js (_penaltyUntil/_penaltyK/bumpPenalty) p/ o transporte do Jev
// (src/jev.js) e os módulos seguintes compartilharem o CÓDIGO com ESTADO independente por lane:
// um 429 do Jev (limite próprio da TypeSafe, ~1.200 rpm) não pode segurar o Gemini, e vice-versa.
//
// Ordem de admissão por chamada paga (contrato do jev.js): getLane(lane) -> penalty.wait() ->
// rateGate.take() -> reserva do orçamento -> request. O portão roda DENTRO da lane de propósito:
// segurar o slot enquanto espera o espaçamento é o próprio limite funcionando (a lane não admite
// mais trabalho do que a taxa escoa).
//
// CONTRATO p/ src/decide.js: o fallback Gemini pega a lane 'llm' SÓ DEPOIS de devolver a lane
// 'jev' (nunca aninhadas — ver o comentário das lanes em src/governor.js). O mesmo vale aqui:
// nunca espere a janela/portão de uma lane segurando o slot da outra.
//
// Import = o do governador (que carrega o config.js: em teste, monte a sandbox ANTES); nada roda no
// load — o reportRateLimit só é chamado no bump de uma lane calibrada.
import { reportRateLimit } from './governor.js';

// Teto de UMA espera de penalidade: 429 em rajada nunca congela a lane por mais de 1 min de uma
// vez — a recuperação de verdade é o AIMD do governador (halva a lane no 429). Diferença p/ o
// llm.js: lá o teto vale só p/ o backoff (um Retry-After de 120s espera 120s); aqui vale p/ os dois.
export const PENALTY_CAP_MS = 60_000;
// Expoente máximo do backoff (2^6 s ≈ 64 s, já acima do teto): impede overflow em 429 contínuo.
const MAX_K = 6;
// Re-checagem durante a espera: a janela pode ter sido ESTENDIDA por outro 429 enquanto dormíamos.
const RECHECK_MS = 5000;
// Default do portão do Jev: 15 rps ≈ 900 rpm, folga sob o limite de 1.200 rpm da TypeSafe
// (a conta/chave é compartilhada com o Gemini no OpenRouter). 0 desliga o portão.
export const DEFAULT_JEV_MAX_RPS = 15;
// Lanes que o governador calibra por 429 (AIMD próprio): o bump da janela avisa o governador.
const GOVERNED_LANES = new Set(['llm', 'jev']);

/** Sleep ABORTÁVEL: rejeita com signal.reason (ou um Error) no abort; ms <= 0 resolve na hora. */
export function abortableSleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('espera abortada'));
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('espera abortada'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

// Lê um header de qualquer formato que chega aqui: Headers do SDK (get), headers do got/node
// (objeto com chaves minúsculas, valor string ou string[]) ou objeto literal de teste.
function headerOf(h, name) {
  if (!h) return undefined;
  try {
    if (typeof h.get === 'function') return h.get(name) ?? undefined;
    const v = h[name] ?? h[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  } catch {
    return undefined; // header exótico/proxy: trata como ausente (fail-open)
  }
}

/**
 * Retry-After em ms a partir de um erro do SDK (err.headers), de uma resposta do got/transporte
 * ({headers}), de um erro do got (err.response.headers), de um objeto de headers ou de um número
 * (já em ms). Aceita `retry-after-ms`, `retry-after` em segundos e `retry-after` como HTTP-date.
 * Devolve null quando AUSENTE/inválido — diferente de 0, que é o servidor dizendo "já pode"
 * (o dublê do Jev manda '0' p/ o teste de retry não dormir).
 */
export function retryAfterMsOf(src, now = Date.now()) {
  if (src == null) return null;
  if (typeof src === 'number') return Number.isFinite(src) && src >= 0 ? src : null;
  const h = src.headers ?? src.response?.headers ?? src;
  const msRaw = headerOf(h, 'retry-after-ms');
  if (msRaw != null && String(msRaw).trim() !== '') {
    const ms = Number(msRaw);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  const raw = headerOf(h, 'retry-after');
  if (raw == null || String(raw).trim() === '') return null;
  const s = Number(raw);
  if (Number.isFinite(s)) return s >= 0 ? s * 1000 : null;
  const at = Date.parse(String(raw)); // Retry-After: <HTTP-date> (RFC 9110)
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * Backoff exponencial com jitter 0.5x–1.5x, teto capMs: min(cap, base·2^attempt·(0.5+rand)).
 * Usado no bump da penalidade (base 1s, como o llm.js) e nos retries de 5xx/rede do jev.js
 * (base 250ms). O jitter espalha as re-tentativas de N chamadas que falharam juntas.
 */
export function backoffMs(attempt, { baseMs = 1000, capMs = PENALTY_CAP_MS, random = Math.random } = {}) {
  const n = Math.max(0, Math.min(Number(attempt) || 0, 30));
  return Math.min(capMs, baseMs * 2 ** n * (0.5 + random()));
}

/**
 * Janela de penalidade de 429 de UMA lane (estado independente por instância).
 * - wait(signal): espera a janela abrir (re-checa a cada 5s: outro 429 pode estendê-la); abortável.
 * - bump(src): registra um 429 — src = erro/resposta/headers/ms (ver retryAfterMsOf). Estende a
 *   janela (nunca a encurta) e avisa o governador (reportRateLimit(lane)) quando a lane é calibrada
 *   ('llm'/'jev'; onRateLimit troca/desliga o aviso). Devolve a espera aplicada em ms.
 * - settle(): chame após um sucesso — janela limpa zera o expoente do backoff (como o llm.js).
 * Política do Retry-After: 'exact' (default; o servidor sabe quando a janela abre — '0' = já; o
 * backoff exponencial só vale quando o header falta) ou 'max' (max(Retry-After, backoff): a
 * semântica ATUAL do src/llm.js, p/ ele migrar p/ cá sem mudar comportamento).
 * coalesceMs: 429s que chegam até N ms depois do último aviso ao governador estendem a janela mas
 * NÃO avisam de novo — as chamadas já em voo quando o 1º 429 chegou foram admitidas ANTES do corte
 * e trazem o MESMO sinal; sem isso, 8 respostas simultâneas halvariam a lane 8× (e o teto
 * calibrado persistiria no piso). 0 = avisa a cada 429 (semântica do llm.js).
 */
export function createPenaltyWindow({
  lane = null,
  baseMs = 1000,
  capMs = PENALTY_CAP_MS,
  retryAfter = 'exact',
  onRateLimit,
  coalesceMs = 0,
  now = Date.now,
  sleep = abortableSleep,
  random = Math.random,
} = {}) {
  let until = 0;
  let k = 0;
  let events = 0;
  let notified = 0; // quantos 429 viraram aviso ao governador
  let lastNotifyAt = -Infinity;
  // onRateLimit explícito vence (inclusive null = não avisar ninguém); sem ele, lane calibrada
  // pelo governador recebe o reportRateLimit(lane) — é o que o bumpPenalty do llm.js faz hoje.
  const notify =
    onRateLimit !== undefined
      ? onRateLimit
      : GOVERNED_LANES.has(lane)
        ? () => reportRateLimit(lane)
        : null;

  return {
    lane,
    async wait(signal) {
      for (;;) {
        if (signal?.aborted) throw signal.reason || new Error('espera abortada');
        const waitMs = until - now();
        if (waitMs <= 0) return;
        await sleep(Math.min(waitMs, RECHECK_MS), signal);
      }
    },
    bump(src) {
      k = Math.min(k + 1, MAX_K);
      events += 1;
      const hinted = retryAfterMsOf(src, now());
      const backoff = backoffMs(k, { baseMs, capMs, random });
      let waitMs;
      if (hinted == null) waitMs = backoff;
      else if (retryAfter === 'max') waitMs = Math.max(hinted, backoff);
      else waitMs = hinted;
      waitMs = Math.min(Math.max(0, waitMs), capMs);
      const t = now();
      const next = t + waitMs;
      if (next > until) until = next;
      if (notify && (coalesceMs <= 0 || t - lastNotifyAt >= coalesceMs)) {
        lastNotifyAt = t;
        notified += 1;
        try {
          notify(lane, { retryAfterMs: hinted, waitMs });
        } catch {
          /* telemetria/AIMD nunca derruba a chamada que tomou o 429 */
        }
      }
      return waitMs;
    },
    settle() {
      if (now() >= until) k = 0;
    },
    reset() {
      until = 0;
      k = 0;
      events = 0;
      notified = 0;
      lastNotifyAt = -Infinity;
    },
    remainingMs() {
      return Math.max(0, until - now());
    },
    state() {
      return { lane, untilMs: until, remainingMs: Math.max(0, until - now()), k, events, notified };
    },
  };
}

/**
 * Portão de requisições por segundo (GCRA: espaçamento mínimo de 1000/rps entre admissões, com
 * rajada opcional de `burst` admissões imediatas). `rps` é número ou função (lida A CADA take —
 * o env/config pode mudar entre comandos da TUI); rps <= 0 desliga. take(signal) reserva o slot
 * SÍNCRONO (ordem FIFO entre chamadas concorrentes) e dorme até ele; abortar devolve o slot se ele
 * ainda for o último reservado. Devolve a espera em ms.
 */
export function createRateGate({ rps = 0, burst = 1, now = Date.now, sleep = abortableSleep } = {}) {
  let tat = 0; // "theoretical arrival time": quando o próximo slot livre começa
  let admitted = 0;
  const readRps = () => {
    try {
      const v = Number(typeof rps === 'function' ? rps() : rps);
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch {
      return 0; // getter quebrado: sem portão (fail-open; a penalidade de 429 segue valendo)
    }
  };

  return {
    async take(signal) {
      if (signal?.aborted) throw signal.reason || new Error('espera abortada');
      const r = readRps();
      if (!r) {
        admitted += 1;
        return 0;
      }
      const interval = 1000 / r;
      const tolerance = Math.max(0, Math.floor(Number(burst) || 1) - 1) * interval;
      const t = now();
      const base = Math.max(tat, t);
      const waitMs = Math.max(0, base - tolerance - t);
      const reserved = base + interval;
      tat = reserved;
      if (waitMs > 0) {
        try {
          await sleep(waitMs, signal);
        } catch (e) {
          if (tat === reserved) tat = base; // ninguém reservou depois: o slot volta p/ a fila
          throw e;
        }
      }
      admitted += 1;
      return waitMs;
    },
    setRps(n) {
      rps = n;
    },
    reset() {
      tat = 0;
      admitted = 0;
    },
    state() {
      const r = readRps();
      return { rps: r, burst, nextAtMs: tat, admitted };
    },
  };
}

/** JEV_MAX_RPS lido do env NA HORA (o config.js já carregou os .env em process.env). */
export function jevMaxRps() {
  const raw = process.env.JEV_MAX_RPS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_JEV_MAX_RPS;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_JEV_MAX_RPS;
}

// ---- registro por lane (singletons compartilhados entre módulos) ----
// O jev.js, o search e os próximos módulos pegam a MESMA janela/portão da lane por aqui: um 429
// visto por qualquer um segura todos. As opções só valem na criação (1ª chamada da lane).
const _penalties = new Map();
const _gates = new Map();

// Coalescência default dos avisos da lane jev: ~3 latências do Jev (~300ms) — o que estava em voo
// quando o 1º 429 chegou conta como UM corte multiplicativo (como o TCP: 1 corte por RTT).
const JEV_COALESCE_MS = 1000;

/**
 * Janela de penalidade singleton da lane. Defaults: 'llm' = política 'max' e aviso a cada 429 (a
 * semântica do llm.js); 'jev' = Retry-After exato e avisos coalescidos em 1s. Lanes calibradas
 * ('llm'/'jev') já chamam reportRateLimit(lane) no bump — quem usa a janela NÃO chama de novo.
 */
export function penaltyWindowFor(lane, opts = {}) {
  let w = _penalties.get(lane);
  if (!w) {
    w = createPenaltyWindow({
      lane,
      retryAfter: lane === 'llm' ? 'max' : 'exact',
      coalesceMs: lane === 'jev' ? JEV_COALESCE_MS : 0,
      ...opts,
    });
    _penalties.set(lane, w);
  }
  return w;
}

/** Portão de rps singleton da lane. Default: 'jev' lê JEV_MAX_RPS a cada take; as outras, sem portão. */
export function rateGateFor(lane, opts = {}) {
  let g = _gates.get(lane);
  if (!g) {
    g = createRateGate({ rps: lane === 'jev' ? jevMaxRps : 0, ...opts });
    _gates.set(lane, g);
  }
  return g;
}

/** Zera o registro (testes e re-init). As instâncias antigas continuam válidas, só desligadas dele. */
export function resetRateLimits() {
  _penalties.clear();
  _gates.clear();
}
