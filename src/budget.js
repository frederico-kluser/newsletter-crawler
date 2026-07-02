// Ledger de orçamento: admissão por RESERVA no ponto da chamada HTTP + custo REAL por
// chamada vindo do OpenRouter (usage accounting: `usage.cost`, em USD), persistido em
// runs/llm_usage. O ledger grava SEMPRE (mesmo sem limite); com --budget/BUDGET_USD > 0
// ele também freia: admite uma chamada sse spent + reservadoEmVoo + estimativa <= budget.
// A estimativa por (stage, model) é 2x o EMA do custo observado (seed conservador por tier),
// então o overshoot fica limitado a somatório de (custo_i - reserva_i) das chamadas em voo.
import { stmts } from './db.js';
import { log, warn, debug } from './util.js';

// Seeds por tier ANTES de haver dados (corrigidos pelo EMA em ~10 chamadas). Pro assume o
// pior caso (xhigh: reasoning é cobrado como output). Reserva clampada em [seed/10, CAP].
const SEED_FLASH = 0.005;
const SEED_PRO = 0.05;
const RESERVE_CAP = 0.25;
const EMA_ALPHA = 0.2;

export class BudgetExceededError extends Error {
  constructor(message = 'orçamento do run esgotado') {
    super(message);
    this.name = 'BudgetExceededError';
    this.code = 'BUDGET_EXCEEDED';
  }
}

/** Puro/injetável (persist é um callback) — a fiação com o SQLite fica no singleton abaixo. */
export class BudgetLedger {
  constructor({ budgetUsd = 0, persist = null } = {}) {
    this.budgetUsd = Number(budgetUsd) > 0 ? Number(budgetUsd) : 0;
    this.persist = persist;
    this.spentUsd = 0;
    this.reservedUsd = 0;
    this.calls = 0;
    this.stopped = false;
    this.byStage = new Map();
    this._ema = new Map(); // `${stage}:${model}` -> EMA do custo observado
    this._warnedNoUsage = false;
  }

  seedFor(model) {
    return String(model || '').includes('flash') ? SEED_FLASH : SEED_PRO;
  }

  estimate(stage, model) {
    const seed = this.seedFor(model);
    const ema = this._ema.get(`${stage}:${model}`);
    if (ema == null) return seed;
    return Math.min(Math.max(2 * ema, seed / 10), RESERVE_CAP);
  }

  /** SOFT stop p/ os drivers: não vale INICIAR trabalho novo (nem a chamada mais barata cabe). */
  shouldStop() {
    if (!this.budgetUsd) return false;
    if (this.stopped) return true;
    return this.calls > 0 && this.spentUsd + this.reservedUsd + SEED_FLASH > this.budgetUsd;
  }

  _trip() {
    if (this.stopped) return;
    this.stopped = true;
    warn(
      `orçamento atingido: US$ ${this.spentUsd.toFixed(4)} de US$ ${this.budgetUsd.toFixed(2)} — ` +
        'parada graciosa, sem novas chamadas LLM (frontier/pendências retomam no próximo run)',
    );
  }

  /**
   * Admite (ou nega com BudgetExceededError) UMA chamada LLM. Devolve um token de uso único:
   * commit({model, usage}) registra o custo real e libera a reserva; cancel() só libera
   * (falha de HTTP não é cobrada pelo OpenRouter). Regra da 1ª chamada: com nada gasto nem
   * em voo, admite sempre — um --budget minúsculo ainda faz ao menos 1 chamada.
   */
  reserve(stage, model) {
    let est = 0;
    if (this.budgetUsd) {
      if (this.stopped) throw new BudgetExceededError();
      est = this.estimate(stage, model);
      const first = this.calls === 0 && this.spentUsd === 0 && this.reservedUsd === 0;
      if (!first && this.spentUsd + this.reservedUsd + est > this.budgetUsd) {
        this._trip();
        throw new BudgetExceededError();
      }
      this.reservedUsd += est;
    }
    let done = false;
    const release = () => {
      if (done) return false;
      done = true;
      this.reservedUsd = Math.max(0, this.reservedUsd - est);
      return true;
    };
    return {
      commit: ({ model: usedModel = model, usage } = {}) => {
        if (!release()) return;
        const raw = Number(usage?.cost);
        const costUsd = Number.isFinite(raw) && raw >= 0 ? raw : 0;
        if (!usage && !this._warnedNoUsage) {
          this._warnedNoUsage = true;
          warn('ledger: resposta sem `usage` — custo registrado como 0 (usage accounting indisponível?)');
        }
        this.spentUsd += costUsd;
        this.calls += 1;
        const s = this.byStage.get(stage) || { calls: 0, costUsd: 0 };
        s.calls += 1;
        s.costUsd += costUsd;
        this.byStage.set(stage, s);
        const k = `${stage}:${usedModel}`;
        const prev = this._ema.get(k);
        this._ema.set(k, prev == null ? costUsd : EMA_ALPHA * costUsd + (1 - EMA_ALPHA) * prev);
        if (this.persist) {
          this.persist({
            stage,
            model: usedModel,
            prompt_tokens: usage?.prompt_tokens ?? null,
            completion_tokens: usage?.completion_tokens ?? null,
            cost_usd: costUsd,
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
      byStage: Object.fromEntries(this.byStage),
    };
  }
}

// ---- singleton do processo (fiação com runs/llm_usage) ----

let _run = null; // { id, command, budgetUsd, ledger, totalUsd, totalCalls }
let _default = null; // ledger ilimitado p/ chamadas fora de um run (eval/, usos avulsos)

function persistRow(row) {
  try {
    stmts.insertLlmUsage.run({ run_id: _run?.id ?? null, ...row });
  } catch (e) {
    debug('ledger: falha ao gravar llm_usage:', e.message);
  }
}

function currentLedger() {
  if (_run) return _run.ledger;
  if (!_default) _default = new BudgetLedger({ budgetUsd: 0, persist: persistRow });
  return _default;
}

/** Abre um run (linha em `runs`) e reseta o ledger. Re-init seguro (a TUI encadeia comandos). */
export function beginRun({ command, budgetUsd = 0, args = null }) {
  let id = null;
  try {
    id = stmts.insertRun.get({
      command,
      args: args ? JSON.stringify(args) : null,
      budget_usd: budgetUsd > 0 ? budgetUsd : null,
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
  _run = {
    id,
    command,
    budgetUsd: Number(budgetUsd) > 0 ? Number(budgetUsd) : 0,
    ledger: new BudgetLedger({ budgetUsd, persist: persistRow }),
    totalUsd,
    totalCalls,
  };
  return id;
}

/** Fecha o run (status + extrato). Chamar em finally — roda também em falha. */
export function endRun(statusOverride) {
  if (!_run) return;
  const { id, command, budgetUsd, ledger } = _run;
  const status = statusOverride || (ledger.stopped ? 'budget_stopped' : 'done');
  try {
    if (id != null) stmts.finishRun.run({ id, status });
  } catch {
    /* extrato abaixo ainda vale */
  }
  const snap = ledger.snapshot();
  if (snap.calls > 0 || budgetUsd > 0) {
    const cap = budgetUsd > 0 ? ` de US$ ${budgetUsd.toFixed(2)}` : '';
    log(`extrato do run${id != null ? ` #${id}` : ''} (${command}): ${snap.calls} chamadas, US$ ${snap.spentUsd.toFixed(4)}${cap} (${status})`);
    for (const [stage, s] of Object.entries(snap.byStage)) {
      log(`  ${stage}: ${s.calls}x — US$ ${s.costUsd.toFixed(4)}`);
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

/** Admissão de UMA chamada LLM (ver BudgetLedger.reserve). Fora de um run: ilimitado. */
export function reserve(stage, model) {
  return currentLedger().reserve(stage, model);
}

/** SOFT stop p/ drivers (loops de estágio e claim do crawl). */
export function shouldStop() {
  return _run ? _run.ledger.shouldStop() : false;
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
    byStage: snap.byStage,
    totalUsd: (_run?.totalUsd ?? 0) + snap.spentUsd,
    totalCalls: (_run?.totalCalls ?? 0) + snap.calls,
  };
}
