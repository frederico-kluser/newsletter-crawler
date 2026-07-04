// Scoring PURO do eval de relevância (sem I/O, sem LLM) — importado por run-eval.mjs e pelos testes.
// records: [{ scn, id, gtRel, predRel, gtKind, predKind, ms, fail }]
//   gtRel/predRel ∈ {direct, similar, none}; gtKind/predKind ∈ {news, tool}.
// `isRel` define o que conta como "relevante" na métrica binária de precisão/recall/F1:
//   - AMPLO (default): direct ∪ similar  — casa com o resultado hoje (direct+similar são hits).
//   - ESTRITO: só direct — mede a busca precisão-primeiro (o toggle "estrito").
// P/R/F1 são MACRO por cenário; acc3way e kindAcc são independentes de isRel.

export const REL_BROAD = (rel) => rel === 'direct' || rel === 'similar';
export const REL_STRICT = (rel) => rel === 'direct';

export function scoreCell(records, { isRel = REL_BROAD } = {}) {
  const perScn = new Map();
  let latSum = 0, fails = 0, exact3 = 0, kindOk = 0, n = 0;
  for (const r of records) {
    n++; latSum += r.ms; if (r.fail) fails++;
    if (r.gtRel === r.predRel) exact3++;
    if (r.gtKind === r.predKind) kindOk++;
    if (!perScn.has(r.scn)) perScn.set(r.scn, { tp: 0, fp: 0, fn: 0, tn: 0 });
    const c = perScn.get(r.scn);
    const g = isRel(r.gtRel), p = isRel(r.predRel);
    if (g && p) c.tp++; else if (!g && p) c.fp++; else if (g && !p) c.fn++; else c.tn++;
  }
  const scn = {};
  let f1sum = 0, pSum = 0, rSum = 0, k = 0;
  for (const [name, c] of perScn) {
    const prec = c.tp + c.fp ? c.tp / (c.tp + c.fp) : 0;
    const rec = c.tp + c.fn ? c.tp / (c.tp + c.fn) : 0;
    const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
    scn[name] = { ...c, precision: +prec.toFixed(3), recall: +rec.toFixed(3), f1: +f1.toFixed(3) };
    f1sum += f1; pSum += prec; rSum += rec; k++;
  }
  return {
    n,
    macroF1: +(f1sum / (k || 1)).toFixed(4),
    macroPrecision: +(pSum / (k || 1)).toFixed(4),
    macroRecall: +(rSum / (k || 1)).toFixed(4),
    acc3way: +(exact3 / (n || 1)).toFixed(4),
    kindAcc: +(kindOk / (n || 1)).toFixed(4),
    meanMs: Math.round(latSum / (n || 1)),
    jsonFails: fails,
    perScenario: scn,
  };
}

export function missSummary(records, { isRel = REL_BROAD } = {}) {
  const fp = [], fn = [];
  for (const r of records) {
    const g = isRel(r.gtRel), p = isRel(r.predRel);
    if (!g && p) fp.push(`${r.scn}:${r.id}`);
    if (g && !p) fn.push(`${r.scn}:${r.id}`);
  }
  return { fp, fn };
}
