// Relógio de TRABALHO por job + abort real. O deadline antigo (withTimeout) contava o tempo de
// PAREDE do job inteiro — espera de fila de lane, politeness por host e chamadas LLM inclusas —
// e não cancelava nada ao estourar: o job virava zumbi segurando as lanes e derrubava os
// seguintes em cascata (run real: 194/194 estouros, 0 salvos). Aqui o relógio só anda dentro
// das fases de trabalho marcadas (fetch/render/parse); esperas ficam com o relógio parado mas
// medidas p/ diagnóstico. Ao expirar, o AbortController é abortado: got/Playwright/LLM em voo
// param de verdade e devolvem as lanes.
export function createJobClock(workBudgetMs, { now = Date.now } = {}) {
  const ac = new AbortController();
  const phases = {}; // ms de TRABALHO por fase (conta no orçamento)
  const waits = {}; // ms de ESPERA por rótulo (não conta; só diagnóstico)
  const enabled = Number.isFinite(workBudgetMs) && workBudgetMs > 0;
  let timer = null;
  let phase = null;
  let startedAt = 0;
  let spentMs = 0;
  let expired = false;
  let abortReason = null;

  const closePhase = () => {
    if (!phase) return;
    if (timer) clearTimeout(timer);
    timer = null;
    const d = Math.max(0, now() - startedAt);
    phases[phase] = (phases[phase] || 0) + d;
    spentMs += d;
    phase = null;
  };

  const doAbort = (reason) => {
    if (ac.signal.aborted) return;
    closePhase();
    expired = true;
    abortReason = reason;
    const e = new Error(`job excedeu o deadline de ${workBudgetMs}ms de trabalho (${reason})`);
    e.code = 'JOB_TIMEOUT';
    ac.abort(e);
  };

  return {
    signal: ac.signal,
    expired: () => expired,
    /** Corte externo (ex.: teto duro de parede) — mata o trabalho em voo, sem zumbi. */
    abort(reason = 'abort') {
      doAbort(reason);
    },
    /** Executa `fn` com o relógio ANDANDO sob a fase `name`. Re-entrância: se já há fase
     * ativa, roda por baixo dela (o tempo conta na fase externa). */
    async run(name, fn) {
      if (ac.signal.aborted) throw ac.signal.reason;
      if (!enabled || phase) return fn();
      phase = name || 'work';
      startedAt = now();
      timer = setTimeout(() => doAbort('work-budget'), Math.max(1, workBudgetMs - spentMs));
      timer.unref?.();
      try {
        return await fn();
      } finally {
        closePhase();
      }
    },
    /** Executa `fn` com o relógio PARADO, medindo a espera sob `name` p/ o diagnóstico. */
    async wait(name, fn) {
      const t0 = now();
      try {
        return await fn();
      } finally {
        waits[name] = (waits[name] || 0) + Math.max(0, now() - t0);
      }
    },
    /** Registra uma espera já medida pelo chamador (ex.: fila de uma lane p-limit). */
    noteWait(name, ms) {
      if (Number.isFinite(ms) && ms > 0) waits[name] = (waits[name] || 0) + ms;
    },
    /** Onde o tempo foi: alimenta o detail do evento job/timeout (ncrawl inspect). */
    snapshot() {
      const r = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
      return {
        budgetMs: enabled ? workBudgetMs : 0,
        workMs: Math.round(spentMs + (phase ? now() - startedAt : 0)),
        phases: r(phases),
        waits: r(waits),
        expired,
        ...(abortReason ? { abortReason } : {}),
      };
    },
  };
}

/** Erro coerente p/ caminhos que checam o sinal manualmente (fases sem suporte a AbortSignal). */
export function abortErrorOf(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const e = new Error('job abortado');
  e.code = 'JOB_TIMEOUT';
  return e;
}
