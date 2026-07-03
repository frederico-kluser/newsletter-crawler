// Progresso AO VIVO da run em memória (sem SQL): o que está acontecendo AGORA (fases ativas),
// contadores acumulados, fontes conhecidas/concluídas e o avanço por DATA rumo ao --since.
// Alimentado por fetch/crawl/commands; lido pelo painel da TUI (getRunProgress) e pela linha
// periódica do CLI. Só importa run-events.js — uma folha SEM imports, então não há risco de ciclo:
// os marcos "fonte concluída"/"data-alvo alcançada" nascem AQUI (na transição, com o nome do map).
import { emitRunEvent } from './run-events.js';

function fresh() {
  return {
    active: false,
    sinceMs: null,
    stages: {}, // nome -> nº de operações NESTA fase agora (fetch/render/limpeza/curadoria/…)
    counts: {}, // acumulados: salvos/enriquecidos/blurb/estouros/itensCurados/verificados/…
    sources: new Map(), // id -> { name, oldestMs, floorHit, listingDone }
  };
}
const st = fresh();

/** Zera o estado no início de cada crawl (a TUI roda vários comandos no mesmo processo). */
export function progressReset({ sinceDate = null } = {}) {
  Object.assign(st, fresh());
  st.active = true;
  st.sinceMs = sinceDate instanceof Date ? sinceDate.getTime() : null;
}

export function stageEnter(name) {
  st.stages[name] = (st.stages[name] || 0) + 1;
}
export function stageExit(name) {
  const n = (st.stages[name] || 0) - 1;
  if (n > 0) st.stages[name] = n;
  else delete st.stages[name];
}
/** Envelopa `fn` como uma operação viva da fase `name` (aparece na linha "agora:" do painel). */
export async function inStage(name, fn) {
  stageEnter(name);
  try {
    return await fn();
  } finally {
    stageExit(name);
  }
}

export function bump(name, n = 1) {
  st.counts[name] = (st.counts[name] || 0) + n;
}

export function sourceSeen(id, name) {
  if (id == null) return;
  if (!st.sources.has(id)) {
    st.sources.set(id, { name: name || `#${id}`, oldestMs: null, floorHit: false, listingDone: false });
  }
}
export function sourceListingDone(id) {
  const s = st.sources.get(id);
  if (s && !s.listingDone) {
    s.listingDone = true;
    emitRunEvent({ phase: 'discovery', kind: 'source-done', level: 'success', source: s.name });
  }
}
/** Registra uma data de item vista p/ a fonte (listagem pareada, issue curada, published do
 * artigo). Guardamos a MAIS ANTIGA: é ela que mede o quanto já andamos rumo ao --since. */
export function dateSeen(id, date) {
  const s = st.sources.get(id);
  const t = date instanceof Date ? date.getTime() : NaN;
  if (!s || !Number.isFinite(t)) return;
  if (s.oldestMs == null || t < s.oldestMs) s.oldestMs = t;
}
/** A fonte ALCANÇOU o piso --since (paginação/scroll pararam por data): progresso = 100%. */
export function floorHit(id) {
  const s = st.sources.get(id);
  if (s && !s.floorHit) {
    s.floorHit = true;
    emitRunEvent({ phase: 'discovery', kind: 'floor-hit', level: 'success', source: s.name });
  }
}

/** % de avanço no tempo: (agora − data mais antiga vista) ÷ (agora − since), clamp 0–100. */
function pctOf(source, sinceMs, nowMs) {
  if (sinceMs == null) return null;
  if (source.floorHit) return 100;
  if (source.oldestMs == null) return null; // fonte ainda sem item datado: "s/ data"
  const span = nowMs - sinceMs;
  if (span <= 0) return 100; // --since no futuro/agora: nada a varrer
  return Math.max(0, Math.min(100, Math.round(((nowMs - source.oldestMs) / span) * 100)));
}

export function progressSnapshot(nowMs = Date.now()) {
  const sources = [...st.sources.entries()].map(([id, s]) => ({
    id,
    name: s.name,
    pct: pctOf(s, st.sinceMs, nowMs),
    floorHit: s.floorHit,
    listingDone: s.listingDone,
    oldest: s.oldestMs != null ? new Date(s.oldestMs).toISOString().slice(0, 10) : null,
  }));
  const withPct = sources.filter((s) => s.pct != null);
  return {
    active: st.active,
    since: st.sinceMs != null ? new Date(st.sinceMs).toISOString().slice(0, 10) : null,
    stages: { ...st.stages },
    counts: { ...st.counts },
    sources,
    sourcesTotal: sources.length,
    sourcesListingDone: sources.filter((s) => s.listingDone).length,
    // Média das fontes COM sinal de data (fontes sem data não entram; aparecem como "s/ data").
    pctGlobal:
      st.sinceMs != null && withPct.length
        ? Math.round(withPct.reduce((a, s) => a + s.pct, 0) / withPct.length)
        : null,
  };
}
