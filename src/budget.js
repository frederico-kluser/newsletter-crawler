// Ledger de orçamento: admissão por RESERVA no ponto da chamada HTTP + custo REAL por
// chamada vindo do OpenRouter (usage accounting: `usage.cost`, em USD), persistido em
// runs/llm_usage. O ledger grava SEMPRE (mesmo sem limite); com --budget/BUDGET_USD > 0
// ele também freia: admite uma chamada sse spent + reservadoEmVoo + estimativa <= budget.
// A estimativa por (stage, model) é 2x o EMA do custo observado (seed conservador por tier),
// então o overshoot fica limitado a somatório de (custo_i - reserva_i) das chamadas em voo.
//
// Migração Jev — o ledger separa os MOTORES: 'jev' (Decisions API, typesafe/*) × 'chat'
// (Gemini/DeepSeek via chat completions, inclusive o fallback). Três freios novos:
//  - 402 (créditos do OpenRouter esgotados): creditsExhausted() trava o ledger mesmo SEM --budget;
//    o reserve lança CreditsExhaustedError (code BUDGET_EXCEEDED → os drivers já param com graça).
//  - sub-orçamento do FALLBACK Gemini (GEMINI_FALLBACK_BUDGET_USD; com --budget e sem a env, 50%
//    dele): estourou → FallbackBudgetExceededError (code PRÓPRIO) — a decisão fica com a melhor
//    resposta do Jev em vez de parar a run.
//  - DEV_SPEND_GUARDED=1 (filho do scripts/dev-spend.mjs): BUDGET_USD vira teto também FORA de um
//    beginRun (eval/smoke chamam o Jev direto) e limita o --budget de qualquer run.
import { stmts } from './db.js';
import { log, warn, debug } from './util.js';
import { reset as decisionStatsReset, snapshot as decisionStatsSnapshot } from './decision-stats.js';

// Seeds por motor/tier ANTES de haver dados (corrigidos pelo EMA em ~10 chamadas). Jev: ~US$ 0,00026
// medido por chamada (8 perguntas, ~6,2K tokens de entrada; saída grátis) → 0.0005 dá 2x de folga —
// com o seed antigo (0.05, "pro") uma chamada do Jev reservava ~200x o custo real e um --budget
// pequeno admitia 1-2 decisões em voo. Gemini/Flash: 0.01 (Gemini 3.8 Flash cobra saída a US$
// 3,75/M). Resto: pior caso (reasoning alto é cobrado como output). Reserva clampada em [seed/10, CAP].
const SEED_JEV = 0.0005;
const SEED_CHAT = 0.01;
const SEED_PRO = 0.05;
// shouldStop pergunta "cabe AINDA ALGUMA chamada?" — a mais barata é a do Jev.
const SEED_MIN = Math.min(SEED_JEV, SEED_CHAT, SEED_PRO);
const RESERVE_CAP = 0.25;
const EMA_ALPHA = 0.2;
// Sem GEMINI_FALLBACK_BUDGET_USD explícito, o fallback pode gastar no máximo esta fração do --budget:
// uma tempestade de fallback (Jev inseguro em tudo) não come o orçamento inteiro da run.
const FALLBACK_SHARE_OF_BUDGET = 0.5;
const ENGINES = Object.freeze(['jev', 'chat']);

/** Motor de um slug: 'jev' (Decisions API) ou 'chat' (chat completions: Gemini, DeepSeek…). */
export function engineOf(model) {
  const m = String(model || '').toLowerCase();
  return m.startsWith('typesafe/') || m.includes('jev') ? 'jev' : 'chat';
}

/** Seed de reserva de um slug (antes de haver EMA): jev 0.0005, gemini/flash 0.01, resto 0.05. */
export function seedForModel(model) {
  const m = String(model || '').toLowerCase();
  if (engineOf(m) === 'jev') return SEED_JEV;
  if (m.includes('gemini') || m.includes('flash')) return SEED_CHAT;
  return SEED_PRO;
}

const normEngine = (e) => (e === 'jev' ? 'jev' : 'chat');

export class BudgetExceededError extends Error {
  constructor(message = 'orçamento do run esgotado', { reason = 'budget' } = {}) {
    super(message);
    this.name = 'BudgetExceededError';
    this.code = 'BUDGET_EXCEEDED';
    this.reason = reason;
  }
}

/**
 * HTTP 402 do OpenRouter: a CHAVE ficou sem crédito. Mesmo code do orçamento (BUDGET_EXCEEDED) de
 * propósito — todo driver já trata esse code como parada graciosa com pendências retomáveis, então
 * o 402 não vira uma avalanche de chamadas falhando item a item.
 */
export class CreditsExhaustedError extends BudgetExceededError {
  constructor(message = 'créditos do OpenRouter esgotados (HTTP 402)') {
    super(message, { reason: 'credits' });
    this.name = 'CreditsExhaustedError';
  }
}

/**
 * O fallback Gemini não cabe (sub-orçamento do fallback, ou o orçamento da run não comporta a
 * chamada). NÃO estende BudgetExceededError e tem code PRÓPRIO: quem pede o fallback degrada p/ a
 * melhor resposta do Jev/default — a run segue enquanto o Jev (barato) couber.
 * reason: 'fallback-cap' (sub-teto) | 'run-budget' (o --budget não comporta a chamada Gemini).
 */
export class FallbackBudgetExceededError extends Error {
  constructor(message = 'sub-orçamento do fallback Gemini esgotado', { reason = 'fallback-cap', capUsd = 0 } = {}) {
    super(message);
    this.name = 'FallbackBudgetExceededError';
    this.code = 'FALLBACK_BUDGET_EXCEEDED';
    this.reason = reason;
    this.capUsd = capUsd;
  }
}

const newCounter = () => ({ calls: 0, costUsd: 0, decisions: 0 });
const newStageStats = () => ({
  calls: 0,
  costUsd: 0,
  decisions: 0,
  byEngine: {},
  byModel: {},
  fallback: { calls: 0, costUsd: 0, byReason: {} },
});

function bump(map, key, costUsd, decisions) {
  const c = map[key] || (map[key] = newCounter());
  c.calls += 1;
  c.costUsd += costUsd;
  if (decisions) c.decisions += decisions;
}

// Cópia profunda barata (objetos pequenos: ~20 estágios × poucos modelos) — o snapshot é lido pela
// TUI a cada 300ms e quem o recebe não pode mutar os contadores vivos por acidente.
const clone = (o) => JSON.parse(JSON.stringify(o));

function envUsd(key) {
  const raw = process.env[key];
  if (raw == null || String(raw).trim() === '') return 0;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Puro/injetável (persist é um callback) — a fiação com o SQLite fica no singleton abaixo. */
export class BudgetLedger {
  /**
   * fallbackBudgetUsd: null (default) = regra de runtime (GEMINI_FALLBACK_BUDGET_USD lida NA HORA;
   * sem ela, 50% do budgetUsd; sem nenhum dos dois, ilimitado); número > 0 = sub-teto fixo; 0 = sem.
   */
  constructor({ budgetUsd = 0, persist = null, fallbackBudgetUsd = null } = {}) {
    this.budgetUsd = Number(budgetUsd) > 0 ? Number(budgetUsd) : 0;
    this.persist = persist;
    this.fallbackBudgetUsd = fallbackBudgetUsd == null ? null : Math.max(0, Number(fallbackBudgetUsd) || 0);
    this.spentUsd = 0;
    this.reservedUsd = 0;
    this.calls = 0;
    this.stopped = false;
    this.creditsOut = false;
    this.byStage = new Map();
    this.byModel = {};
    this.byEngine = {};
    this.fallbackSpentUsd = 0;
    this.fallbackReservedUsd = 0;
    this.fallbackCalls = 0;
    this._ema = new Map(); // `${stage}:${modelPedido}` -> EMA do custo observado
    this._warnedNoUsage = false;
    this._warnedFallbackCap = false;
  }

  seedFor(model) {
    return seedForModel(model);
  }

  /** Reserva de UMA chamada: 2x EMA do (stage, modelo PEDIDO), clampada; seed sem dados. */
  estimate(stage, model) {
    const seed = this.seedFor(model);
    const ema = this._ema.get(`${stage}:${model}`);
    if (ema == null) return seed;
    return Math.min(Math.max(2 * ema, seed / 10), RESERVE_CAP);
  }

  /** Sub-teto do fallback Gemini em USD (0 = sem sub-teto; o --budget ainda vale). */
  fallbackCapUsd() {
    if (this.fallbackBudgetUsd != null) return this.fallbackBudgetUsd;
    const explicit = envUsd('GEMINI_FALLBACK_BUDGET_USD');
    if (explicit) return explicit;
    return this.budgetUsd ? this.budgetUsd * FALLBACK_SHARE_OF_BUDGET : 0;
  }

  /** SOFT stop p/ os drivers: não vale INICIAR trabalho novo (nem a chamada mais barata cabe). */
  shouldStop() {
    if (this.creditsOut) return true;
    if (!this.budgetUsd) return false;
    if (this.stopped) return true;
    return this.calls > 0 && this.spentUsd + this.reservedUsd + SEED_MIN > this.budgetUsd;
  }

  _trip() {
    if (this.stopped) return;
    this.stopped = true;
    warn(
      `orçamento atingido: US$ ${this.spentUsd.toFixed(4)} de US$ ${this.budgetUsd.toFixed(2)} — ` +
        'parada graciosa, sem novas chamadas LLM (frontier/pendências retomam no próximo run)',
    );
  }

  /** HTTP 402: a chave ficou sem crédito. Trava o ledger (mesmo sem --budget). Idempotente. */
  creditsExhausted() {
    if (this.creditsOut) return;
    this.creditsOut = true;
    warn(
      'créditos do OpenRouter esgotados (HTTP 402) — parada graciosa, sem novas chamadas; ' +
        'recarregue a chave (ncrawl key) e rode de novo: as pendências retomam',
    );
  }

  _refuseFallback(reason, capUsd, est) {
    if (!this._warnedFallbackCap) {
      this._warnedFallbackCap = true;
      const why =
        reason === 'run-budget'
          ? `o orçamento da run não comporta mais uma chamada Gemini (~US$ ${est.toFixed(4)})`
          : `US$ ${this.fallbackSpentUsd.toFixed(4)} de US$ ${capUsd.toFixed(4)} gastos`;
      warn(`fallback Gemini sem orçamento (${why}) — as decisões incertas ficam com a melhor resposta do Jev`);
    }
    const msg =
      reason === 'run-budget'
        ? 'orçamento da run não comporta o fallback Gemini'
        : 'sub-orçamento do fallback Gemini esgotado';
    throw new FallbackBudgetExceededError(msg, { reason, capUsd });
  }

  /**
   * Admite (ou nega) UMA chamada LLM. Devolve um token de uso único: commit({...}) registra o custo
   * real e libera a reserva; cancel() só libera (falha de HTTP não é cobrada pelo OpenRouter).
   * Regra da 1ª chamada: com nada gasto nem em voo, admite sempre — um --budget minúsculo ainda faz
   * ao menos 1 chamada (idem p/ o 1º fallback frente ao sub-teto).
   * opts.fallback: chamada de FALLBACK (Gemini no lugar de uma decisão incerta do Jev) — sujeita ao
   * sub-teto e, quando não cabe, lança FallbackBudgetExceededError SEM travar a run.
   * Lança: CreditsExhaustedError (402 visto), BudgetExceededError (orçamento), ou
   * FallbackBudgetExceededError (só com opts.fallback).
   */
  reserve(stage, model, { fallback = false } = {}) {
    if (this.creditsOut) throw new CreditsExhaustedError();
    if (this.budgetUsd && this.stopped) throw new BudgetExceededError();
    const fbCap = fallback ? this.fallbackCapUsd() : 0;
    const est = this.budgetUsd || fbCap ? this.estimate(stage, model) : 0;
    if (fbCap) {
      const firstFb = this.fallbackCalls === 0 && this.fallbackSpentUsd === 0 && this.fallbackReservedUsd === 0;
      if (!firstFb && this.fallbackSpentUsd + this.fallbackReservedUsd + est > fbCap) {
        this._refuseFallback('fallback-cap', fbCap, est);
      }
    }
    if (this.budgetUsd) {
      const first = this.calls === 0 && this.spentUsd === 0 && this.reservedUsd === 0;
      if (!first && this.spentUsd + this.reservedUsd + est > this.budgetUsd) {
        // O fallback não trava a run: a próxima decisão do Jev (seed 20x menor) ainda pode caber.
        if (fallback) this._refuseFallback('run-budget', fbCap, est);
        this._trip();
        throw new BudgetExceededError();
      }
      this.reservedUsd += est;
    }
    const fbHeld = fbCap ? est : 0;
    this.fallbackReservedUsd += fbHeld;
    let done = false;
    const release = () => {
      if (done) return false;
      done = true;
      if (this.budgetUsd) this.reservedUsd = Math.max(0, this.reservedUsd - est);
      this.fallbackReservedUsd = Math.max(0, this.fallbackReservedUsd - fbHeld);
      return true;
    };
    return {
      /**
       * model: o slug RESOLVIDO da resposta (gravado no llm_usage.model); requestedModel: o PEDIDO
       * (default: o do reserve) — é a chave do EMA, porque é com ele que estimate() é consultado.
       * usage: {cost, prompt_tokens|input_tokens, completion_tokens|output_tokens}.
       * engine: 'jev'|'chat' (default: deduzido do slug); decisions: perguntas decididas/resolvidas;
       * fallbackReason: motivo quando a chamada é um fallback; latencyMs: duração da chamada.
       */
      commit: ({
        model: usedModel = model,
        usage,
        engine,
        decisions = null,
        fallbackReason = null,
        latencyMs = null,
        requestedModel = null,
      } = {}) => {
        if (!release()) return;
        const raw = Number(usage?.cost);
        const costUsd = Number.isFinite(raw) && raw >= 0 ? raw : 0;
        if (!usage && !this._warnedNoUsage) {
          this._warnedNoUsage = true;
          warn('ledger: resposta sem `usage` — custo registrado como 0 (usage accounting indisponível?)');
        }
        const asked = requestedModel || model || null;
        const resolved = usedModel || asked || '(sem modelo)';
        const eng = normEngine(engine ?? engineOf(resolved));
        const nDec = Number.isFinite(Number(decisions)) && decisions !== null ? Math.max(0, Math.trunc(decisions)) : null;
        const isFallback = fallback || Boolean(fallbackReason);
        const reason = isFallback ? String(fallbackReason || 'fallback') : null;

        this.spentUsd += costUsd;
        this.calls += 1;
        bump(this.byEngine, eng, costUsd, nDec);
        bump(this.byModel, resolved, costUsd, nDec);
        const s = this.byStage.get(stage) || newStageStats();
        s.calls += 1;
        s.costUsd += costUsd;
        if (nDec) s.decisions += nDec;
        bump(s.byEngine, eng, costUsd, nDec);
        bump(s.byModel, resolved, costUsd, nDec);
        if (isFallback) {
          s.fallback.calls += 1;
          s.fallback.costUsd += costUsd;
          s.fallback.byReason[reason] = (s.fallback.byReason[reason] || 0) + 1;
          this.fallbackSpentUsd += costUsd;
          this.fallbackCalls += 1;
        }
        this.byStage.set(stage, s);
        // EMA pelo modelo PEDIDO: estimate() é consultado com ele. Com o resolvido (o que o
        // OpenRouter devolve: 'typesafe/jev-1.13' → 'typesafe/jev-1.13-20260917') o EMA nunca era lido.
        const k = `${stage}:${asked}`;
        const prev = this._ema.get(k);
        this._ema.set(k, prev == null ? costUsd : EMA_ALPHA * costUsd + (1 - EMA_ALPHA) * prev);
        if (this.persist) {
          const lat = Number(latencyMs);
          this.persist({
            stage,
            model: resolved,
            requested_model: asked,
            prompt_tokens: usage?.prompt_tokens ?? usage?.input_tokens ?? null,
            completion_tokens: usage?.completion_tokens ?? usage?.output_tokens ?? null,
            cost_usd: costUsd,
            engine: eng,
            decisions: nDec,
            fallback_reason: reason,
            latency_ms: latencyMs !== null && Number.isFinite(lat) && lat >= 0 ? Math.round(lat) : null,
          });
        }
      },
      cancel: () => {
        release();
      },
    };
  }

  snapshot() {
    return {
      budgetUsd: this.budgetUsd,
      spentUsd: this.spentUsd,
      reservedUsd: this.reservedUsd,
      calls: this.calls,
      stopped: this.stopped,
      creditsOut: this.creditsOut,
      byStage: clone(Object.fromEntries(this.byStage)),
      byModel: clone(this.byModel),
      byEngine: clone(this.byEngine),
      fallback: {
        spentUsd: this.fallbackSpentUsd,
        reservedUsd: this.fallbackReservedUsd,
        calls: this.fallbackCalls,
        capUsd: this.fallbackCapUsd(),
      },
    };
  }
}

// ---- singleton do processo (fiação com runs/llm_usage) ----

let _run = null; // { id, command, budgetUsd, ledger, totalUsd, totalCalls }
let _default = null; // ledger p/ chamadas fora de um run (eval/, usos avulsos): ilimitado, salvo a guarda

function persistRow(row) {
  try {
    stmts.insertLlmUsage.run({ run_id: _run?.id ?? null, ...row });
  } catch (e) {
    debug('ledger: falha ao gravar llm_usage:', e.message);
  }
}

/**
 * Orçamento EFETIVO de uma run. Sob DEV_SPEND_GUARDED=1 (filho do scripts/dev-spend.mjs, que passa
 * BUDGET_USD = o que resta da guarda de gasto do desenvolvimento), BUDGET_USD é TETO: limita um
 * --budget maior e vale mesmo quando a run pediu "ilimitado" (0). Fora da guarda: o pedido, como sempre.
 */
export function resolveRunBudget(askedUsd, env = process.env) {
  const asked = Number(askedUsd) > 0 ? Number(askedUsd) : 0;
  if (env.DEV_SPEND_GUARDED !== '1') return asked;
  const raw = Number(env.BUDGET_USD);
  const guard = Number.isFinite(raw) && raw > 0 ? raw : 0;
  if (!guard) return asked;
  return asked ? Math.min(asked, guard) : guard;
}

function currentLedger() {
  if (_run) return _run.ledger;
  // A guarda do dev-spend vale também FORA de um beginRun: o eval e o smoke chamam o Jev/Gemini
  // direto, e sem isto um filho desgovernado só pararia no poll do /key (atrasado por natureza).
  if (!_default) _default = new BudgetLedger({ budgetUsd: resolveRunBudget(0), persist: persistRow });
  return _default;
}

/** Abre um run (linha em `runs`) e reseta o ledger. Re-init seguro (a TUI encadeia comandos). */
export function beginRun({ command, budgetUsd = 0, args = null }) {
  const effective = resolveRunBudget(budgetUsd);
  if (effective !== (Number(budgetUsd) > 0 ? Number(budgetUsd) : 0)) {
    warn(`DEV_SPEND_GUARDED: orçamento do run limitado a US$ ${effective.toFixed(4)} (o que resta da guarda de gasto)`);
  }
  let id = null;
  try {
    id = stmts.insertRun.get({
      command,
      args: args ? JSON.stringify(args) : null,
      budget_usd: effective > 0 ? effective : null,
    })?.id ?? null;
  } catch (e) {
    debug('ledger: falha ao abrir run:', e.message); // ledger em memória segue funcionando
  }
  let totalUsd = 0;
  let totalCalls = 0;
  try {
    const t = stmts.sumUsageTotal.get();
    totalUsd = t.usd;
    totalCalls = t.n;
  } catch {
    /* acumulado é telemetria; segue */
  }
  // Placar das decisões do Jev é POR RUN (o módulo é global ao processo e a TUI encadeia comandos).
  decisionStatsReset();
  _run = {
    id,
    command,
    budgetUsd: effective,
    ledger: new BudgetLedger({ budgetUsd: effective, persist: persistRow }),
    totalUsd,
    totalCalls,
  };
  return id;
}

const usd = (x) => `US$ ${Number(x || 0).toFixed(4)}`;
const pct1 = (x) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;

function engineSummary(byEngine) {
  const parts = [];
  for (const e of ENGINES) {
    const c = byEngine[e];
    if (!c || !c.calls) continue;
    const dec = c.decisions ? ` · ${c.decisions} decisões` : '';
    parts.push(`${e} ${c.calls}x${dec} · ${usd(c.costUsd)}`);
  }
  return parts.join(' | ');
}

function stageDetail(s) {
  const bits = [];
  const engines = ENGINES.filter((e) => s.byEngine?.[e]?.calls);
  if (engines.length > 1) bits.push(engines.map((e) => `${e} ${s.byEngine[e].calls}x ${usd(s.byEngine[e].costUsd)}`).join(' · '));
  else if (engines.length === 1 && engines[0] === 'jev') bits.push('jev');
  if (s.decisions) bits.push(`${s.decisions} dec`);
  if (s.fallback?.calls) {
    const why = Object.entries(s.fallback.byReason)
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r} ${n}`)
      .join(', ');
    bits.push(`fallback ${s.fallback.calls}x${why ? `: ${why}` : ''}`);
  }
  return bits.length ? ` (${bits.join(' · ')})` : '';
}

/** Fecha o run (status + extrato). Chamar em finally — roda também em falha. */
export function endRun(statusOverride) {
  if (!_run) return;
  const { id, command, budgetUsd, ledger } = _run;
  const status =
    statusOverride || (ledger.creditsOut ? 'credits_exhausted' : ledger.stopped ? 'budget_stopped' : 'done');
  try {
    if (id != null) stmts.finishRun.run({ id, status });
  } catch {
    /* extrato abaixo ainda vale */
  }
  const snap = ledger.snapshot();
  if (snap.calls > 0 || budgetUsd > 0) {
    const cap = budgetUsd > 0 ? ` de US$ ${budgetUsd.toFixed(2)}` : '';
    log(`extrato do run${id != null ? ` #${id}` : ''} (${command}): ${snap.calls} chamadas, US$ ${snap.spentUsd.toFixed(4)}${cap} (${status})`);
    // Linha de motores só quando o Jev entrou: um run 100% chat mantém o extrato de sempre.
    if (snap.byEngine.jev?.calls) {
      const fb = snap.fallback.calls ? ` (fallback ${snap.fallback.calls}x · ${usd(snap.fallback.spentUsd)})` : '';
      log(`  motores: ${engineSummary(snap.byEngine)}${fb}`);
    }
    for (const [stage, s] of Object.entries(snap.byStage)) {
      log(`  ${stage}: ${s.calls}x — US$ ${s.costUsd.toFixed(4)}${stageDetail(s)}`);
    }
    try {
      const dec = decisionStatsSnapshot();
      for (const [stage, d] of Object.entries(dec.byStage)) {
        if (!d.decisions) continue;
        const why = Object.entries(d.byReason)
          .flatMap(([outcome, m]) => Object.entries(m).map(([r, n]) => [`${outcome === 'fallback' ? '' : `${outcome}:`}${r}`, n]))
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([r, n]) => `${r} ${n}`)
          .join(', ');
        log(`  decisões ${stage}: ${d.decisions} · não aceitas ${pct1(d.fallbackRate)}${why ? ` (${why})` : ''}${d.storms ? ' · TEMPESTADE' : ''}`);
      }
    } catch {
      /* placar é telemetria */
    }
    try {
      const t = stmts.sumUsageTotal.get();
      log(`  acumulado all-time: US$ ${t.usd.toFixed(4)} em ${t.n} chamadas`);
    } catch {
      /* opcional */
    }
  }
  _run = null;
}

/**
 * Admissão de UMA chamada LLM/Jev (ver BudgetLedger.reserve). opts.fallback marca o fallback
 * Gemini (sub-orçamento). Fora de um run: ilimitado (salvo DEV_SPEND_GUARDED + BUDGET_USD).
 */
export function reserve(stage, model, opts) {
  return currentLedger().reserve(stage, model, opts);
}

/** SOFT stop p/ drivers (loops de estágio e claim do crawl). Verdadeiro também após um 402. */
export function shouldStop() {
  return currentLedger().shouldStop();
}

/** HTTP 402 visto (jev.js/llm.js): trava o ledger corrente — as próximas reservas lançam. */
export function creditsExhausted() {
  currentLedger().creditsExhausted();
}

/** Estado p/ a TUI/status (contadores em memória — sem SQL no poll de 300ms). */
export function getBudgetState() {
  const snap = currentLedger().snapshot();
  return {
    runId: _run?.id ?? null,
    command: _run?.command ?? null,
    budgetUsd: snap.budgetUsd,
    spentUsd: snap.spentUsd,
    reservedUsd: snap.reservedUsd,
    calls: snap.calls,
    stopped: snap.stopped,
    creditsOut: snap.creditsOut,
    byStage: snap.byStage,
    byModel: snap.byModel,
    byEngine: snap.byEngine,
    fallback: snap.fallback,
    totalUsd: (_run?.totalUsd ?? 0) + snap.spentUsd,
    totalCalls: (_run?.totalCalls ?? 0) + snap.calls,
  };
}

/**
 * Custo esperado de UMA chamada do estágio COM ESTE MODELO, p/ EXIBIR antes de rodar (confirmA da
 * TUI, preflight da busca web): média REAL do llm_usage daquele (stage, modelo pedido) quando há
 * amostra (>=3 chamadas cobradas), senão o seed do modelo. Filtrar pelo modelo importa na migração:
 * a média de um estágio que trocou de deepseek p/ Gemini (ou de chat p/ Jev) mentiria por 10-20x.
 * Não usa currentLedger().estimate() — aquilo é RESERVA (2x EMA) e morre no endRun.
 */
export function estimateStageCallUsd(stage, model) {
  try {
    const h = stmts.avgUsageByStageModel.get({ stage, model: model || null });
    if (h && h.n >= 3 && h.avg > 0) return h.avg;
  } catch {
    /* base antiga sem llm_usage: cai no seed */
  }
  return seedForModel(model);
}
