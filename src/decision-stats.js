// Contadores EM MEMÓRIA das decisões do Jev, por estágio, da run corrente: quantas perguntas o Jev
// decidiu com confiança (accept), quantas foram ao fallback Gemini, ao default ou deram erro — e por
// quê. Alimentado por recordDecisions (src/decide.js) a cada lote; lido pela TUI/inspect/extrato via
// snapshot() SEM SQL (o poll da TUI é de 300ms). O histórico persistente é a tabela jev_decisions
// (events.logDecision); aqui é só o placar ao vivo.
//
// TEMPESTADE DE FALLBACK: quando a fatia NÃO aceita das últimas JEV_STORM_WINDOW (50) decisões de um
// estágio passa de JEV_STORM_RATE (0.6), o Jev deixou de decidir aquele estágio — cada pergunta
// vira uma chamada Gemini (~20-40x mais cara) ou um default. Emite UM aviso + um evento 'jev/storm'
// por episódio (re-arma quando a taxa cai à metade do limiar), nunca um aviso por decisão.
//
// "Não aceita" = fallback + default + error (qualquer desfecho que NÃO usou a resposta do Jev).
// 'shadow' = decisão ACEITA que também foi conferida no Gemini (JEV_SHADOW_RATE) — conta como aceita.
import { warn } from './util.js';
import { logEvent } from './events.js';
import { emitRunEvent } from './run-events.js';

const OUTCOMES = Object.freeze(['accept', 'fallback', 'default', 'error', 'shadow']);
const NON_ACCEPT = Object.freeze(['fallback', 'default', 'error']);
const NON_ACCEPT_SET = new Set(NON_ACCEPT);
// Re-arme com histerese: só um NOVO episódio (a taxa caiu à metade do limiar e voltou a subir) avisa
// de novo — uma taxa oscilando em volta do limiar não vira rajada de avisos.
const STORM_REARM_FACTOR = 0.5;

let _stages = new Map(); // stage -> estado (contadores + janela deslizante)
let _storms = []; // episódios da run: [{ stage, at, rate, window, threshold }]

// Limites lidos NA HORA (o eval/teste troca por env sem reimportar). Fora da faixa → default.
function envNum(key, dflt, min, max) {
  const raw = process.env[key];
  if (raw == null || String(raw).trim() === '') return dflt;
  const v = Number(raw);
  return Number.isFinite(v) && v >= min && v <= max ? v : dflt;
}
const stormRate = () => envNum('JEV_STORM_RATE', 0.6, 0, 1);
const stormWindow = () => Math.trunc(envNum('JEV_STORM_WINDOW', 50, 1, 10000));
// Amostra mínima na janela antes de julgar: com 3 decisões, 2 fallbacks (67%) não é tempestade.
const stormMin = () => Math.min(stormWindow(), Math.trunc(envNum('JEV_STORM_MIN', 20, 1, 10000)));

function newStage() {
  return {
    decisions: 0,
    accept: 0,
    fallback: 0,
    default: 0,
    error: 0,
    shadow: 0,
    byReason: { fallback: {}, default: {}, error: {} },
    window: [], // 1 = não aceita, 0 = aceita (as últimas stormWindow() decisões)
    storm: false,
    storms: 0,
  };
}

const rateOf = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const round4 = (x) => Math.round(x * 1e4) / 1e4;

function emitStorm(stage, s, rate, threshold, { runId }) {
  const n = s.window.length;
  const pct = Math.round(rate * 100);
  const ep = { stage, at: new Date().toISOString(), rate: round4(rate), window: n, threshold };
  _storms.push(ep);
  warn(
    `jev: tempestade de fallback em ${stage} — ${pct}% das últimas ${n} decisões NÃO foram aceitas ` +
      `(limiar ${Math.round(threshold * 100)}%); cada uma vira Gemini ou default — confira o limiar/as ` +
      'perguntas da etapa (inspect --decisions)',
  );
  try {
    logEvent({
      runId: runId ?? null,
      stage: 'jev',
      status: 'storm',
      detail: {
        stage,
        rate: ep.rate,
        window: n,
        threshold,
        byReason: JSON.parse(JSON.stringify(s.byReason)),
      },
    });
  } catch {
    /* telemetria: nunca derruba a decisão */
  }
  try {
    emitRunEvent({ kind: 'jev-fallback-storm', level: 'warn', source: stage, detail: `${stage} ${pct}%` });
  } catch {
    /* idem */
  }
  return ep;
}

/**
 * Conta um lote de decisões de UM estágio. rows: [{ outcome, reason? }] (as mesmas linhas que o
 * recordDecisions manda ao events.logDecision; campos extras são ignorados). opts: { runId }.
 * Devolve { storm } — o episódio recém-detectado, ou null. Nunca lança.
 */
export function record(stage, rows, { runId = null } = {}) {
  try {
    const name = String(stage || '').trim();
    const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
    if (!name || !list.length) return { storm: null };
    const s = _stages.get(name) || newStage();
    _stages.set(name, s);
    const maxWin = stormWindow();
    for (const r of list) {
      const outcome = String(r?.outcome ?? '').toLowerCase();
      if (!OUTCOMES.includes(outcome)) continue;
      s.decisions++;
      s[outcome]++;
      const miss = NON_ACCEPT_SET.has(outcome);
      if (miss) {
        const reason = String(r?.reason || 'unspecified');
        s.byReason[outcome][reason] = (s.byReason[outcome][reason] || 0) + 1;
      }
      s.window.push(miss ? 1 : 0);
    }
    if (s.window.length > maxWin) s.window.splice(0, s.window.length - maxWin);

    const threshold = stormRate();
    const rate = rateOf(s.window);
    let storm = null;
    if (!s.storm && s.window.length >= stormMin() && rate > threshold) {
      s.storm = true;
      s.storms++;
      storm = emitStorm(name, s, rate, threshold, { runId });
    } else if (s.storm && rate <= threshold * STORM_REARM_FACTOR) {
      s.storm = false; // episódio encerrado: o próximo pico avisa de novo
    }
    return { storm };
  } catch {
    return { storm: null };
  }
}

/** Fatia NÃO aceita (fallback+default+error) de um estágio na run, ou null sem decisões. */
export function fallbackRate(stage) {
  const s = _stages.get(stage);
  if (!s || !s.decisions) return null;
  return (s.fallback + s.default + s.error) / s.decisions;
}

/**
 * Placar p/ TUI/inspect/extrato (cópia — mutar não afeta os contadores):
 * { byStage: { [stage]: { decisions, accept, fallback, default, error, shadow,
 *                         byReason:{fallback:{motivo:n}, default:{…}, error:{…}},
 *                         fallbackRate, windowRate, windowSize, storm, storms } },
 *   totals: { decisions, accept, fallback, default, error, shadow, fallbackRate },
 *   storms: [{ stage, at, rate, window, threshold }] }
 */
export function snapshot() {
  const byStage = {};
  const totals = { decisions: 0, accept: 0, fallback: 0, default: 0, error: 0, shadow: 0, fallbackRate: 0 };
  for (const [stage, s] of _stages) {
    const miss = s.fallback + s.default + s.error;
    byStage[stage] = {
      decisions: s.decisions,
      accept: s.accept,
      fallback: s.fallback,
      default: s.default,
      error: s.error,
      shadow: s.shadow,
      byReason: JSON.parse(JSON.stringify(s.byReason)),
      fallbackRate: s.decisions ? round4(miss / s.decisions) : 0,
      windowRate: round4(rateOf(s.window)),
      windowSize: s.window.length,
      storm: s.storm,
      storms: s.storms,
    };
    for (const k of OUTCOMES) totals[k] += s[k];
    totals.decisions += s.decisions;
  }
  const miss = totals.fallback + totals.default + totals.error;
  totals.fallbackRate = totals.decisions ? round4(miss / totals.decisions) : 0;
  return { byStage, totals, storms: _storms.map((e) => ({ ...e })) };
}

/** Zera o placar (início de cada run — o beginRun do budget.js chama). */
export function reset() {
  _stages = new Map();
  _storms = [];
}

// Nomes descritivos p/ quem importa junto com outros snapshot/reset (commands.js, runLines).
export const decisionStatsSnapshot = snapshot;
export const decisionStatsReset = reset;
export const recordDecisionStats = record;
