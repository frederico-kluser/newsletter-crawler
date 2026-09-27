// Calibração do Jev — funções PURAS (sem rede, sem banco, sem disco). O runner lê as respostas
// cacheadas e chama isto quantas vezes quiser: varrer limiar custa US$ 0.
//
// As duas semânticas do contrato (config/jev-thresholds.json) têm um varredor cada:
// - FAIXA de probabilidade {lo, hi} sobre o p de um noul (ou o pMass de uma choice):
//   p >= hi → sim, p <= lo → não, entre os dois → incerto (vai p/ o fallback Gemini). `sweep`.
// - Limiar de CERTEZA (minConf): aceita a resposta do Jev se certainty >= τ, senão fallback.
//   `selectiveSweep`.
// Nunca compare probabilidades de perguntas diferentes: cada id de pergunta tem a própria varredura.
//
// Convenção de divisão por zero (vale p/ todas as métricas de P/R): sem previsão positiva E sem
// positivo no gold, precisão e recall valem 1 (acerto vazio); com um lado vazio só, valem 0.
// Nas MÉDIAS MACRO (multiClassMetrics, multiLabelAgreement) uma classe/faceta AUSENTE dos dois lados
// (sem suporte no gold e sem nenhuma previsão) fica FORA da média — continua em perClass/facets,
// marcada `absent: true`. Sem isso o acerto vazio (F1 = 1) entrava na média e UMA previsão perdida
// naquela classe virava F1 = 0: um degrau de 1/|classes| que dependia só de ONDE o erro caiu, e
// uma escolha de limiar por macroF1 (Jev × baseline DeepSeek) oscilaria em amostra sem a classe. Se
// TODAS estão ausentes, a média cai no acerto vazio (1) — não há o que discriminar.

// ---- intervalos e grades ----

/**
 * Intervalo de Wilson (proporção k/n, z=1.96 ≈ 95%). n=0 → {p:0, lo:0, hi:1}: sem dado, o
 * intervalo é o [0,1] inteiro — o relatório precisa mostrar a incerteza, não um 0 "exato".
 */
export function wilson(k, n, z = 1.96) {
  if (!(n > 0)) return { k: 0, n: 0, p: 0, lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { k, n, p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/** Grade inclusiva from..to com passo `step`, sem o ruído de float (0.30000000000000004). */
export function thresholdGrid(from, to, step) {
  if (!(step > 0)) throw new Error('thresholdGrid: step precisa ser > 0');
  const decimals = Math.max(0, ...[from, to, step].map((x) => (String(x).split('.')[1] || '').length));
  const out = [];
  const n = Math.floor((to - from) / step + 1e-9);
  for (let i = 0; i <= n; i++) out.push(Number((from + i * step).toFixed(decimals)));
  return out;
}

/** Todas as faixas {lo, hi} com lo < hi a partir de duas grades. */
export function bandGrid(los, his) {
  const out = [];
  for (const lo of los) for (const hi of his) if (lo < hi) out.push({ lo, hi });
  return out;
}

// ---- helpers binários ----

// Gold/previsão aceitam boolean, 0/1 ou 'yes'/'no' (o que vier do cache ou do banco).
export function toBool(y) {
  if (y === true || y === 1 || y === '1' || y === 'yes' || y === 'true') return true;
  if (y === false || y === 0 || y === '0' || y === 'no' || y === 'false') return false;
  return null;
}

/** Precisão/recall/F1 a partir da matriz (convenção de zero no topo do arquivo). */
export function prf({ tp = 0, fp = 0, fn = 0 }) {
  const precision = tp + fp ? tp / (tp + fp) : fn === 0 ? 1 : 0;
  const recall = tp + fn ? tp / (tp + fn) : fp === 0 ? 1 : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

function tally(pairs) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const [pred, gold] of pairs) {
    if (pred && gold) tp++;
    else if (pred && !gold) fp++;
    else if (!pred && gold) fn++;
    else tn++;
  }
  const n = tp + fp + fn + tn;
  return { tp, fp, fn, tn, ...prf({ tp, fp, fn }), accuracy: n ? (tp + tn) / n : 0 };
}

const bandOf = (th) => (typeof th === 'number' ? { lo: null, hi: th } : { lo: th.lo ?? null, hi: th.hi });

/** Decisão de UM item numa faixa: 'yes' | 'no' | 'uncertain' (score inválido = incerto). */
export function decideBand(score, th) {
  if (!Number.isFinite(score)) return 'uncertain';
  const { lo, hi } = bandOf(th);
  if (score >= hi) return 'yes';
  if (lo == null || score <= lo) return 'no';
  return 'uncertain';
}

/** Custo por 1.000 itens: primário sempre + fallback só na fração não coberta. */
export function costPer1k({ coverage, primaryUsd = 0, fallbackUsd = 0 }) {
  return 1000 * (primaryUsd + (1 - coverage) * fallbackUsd);
}

/**
 * Varredura BINÁRIA de limiares. `scores[i]` = probabilidade do positivo; `labels[i]` = gold.
 * Cada limiar é um número t (sim se score >= t, sem abstenção) ou uma faixa {lo, hi} (abstém
 * entre os dois). Item sem gold é ignorado; score não-finito conta como abstenção.
 * opts.fallback: previsões do fallback alinhadas (array ou (i) => bool) → métricas `blended`
 *   (os abstidos recebem a resposta do fallback — é a qualidade que a produção entregaria).
 * opts.costs: {primaryUsd, fallbackUsd} por item → costPer1k.
 * Devolve 1 linha por limiar: {threshold, lo, hi, n, answered, abstained, coverage, fallbackRate,
 * tp, fp, fn, tn, precision, recall, f1, accuracy, positiveRate, blended?, costPer1k?}.
 */
export function sweep(scores, labels, thresholds, opts = {}) {
  if (scores.length !== labels.length) throw new Error('sweep: scores e labels com tamanhos diferentes');
  const fb = typeof opts.fallback === 'function' ? opts.fallback : opts.fallback ? (i) => opts.fallback[i] : null;
  const idx = [];
  for (let i = 0; i < labels.length; i++) if (toBool(labels[i]) !== null) idx.push(i);
  return thresholds.map((th) => {
    const { lo, hi } = bandOf(th);
    const decided = [];
    const blendedPairs = [];
    let abstained = 0;
    let fallbackMissing = 0;
    for (const i of idx) {
      const gold = toBool(labels[i]);
      const d = decideBand(scores[i], th);
      if (d === 'uncertain') {
        abstained++;
        if (fb) {
          const f = toBool(fb(i));
          if (f === null) fallbackMissing++;
          else blendedPairs.push([f, gold]);
        }
        continue;
      }
      decided.push([d === 'yes', gold]);
      blendedPairs.push([d === 'yes', gold]);
    }
    const n = idx.length;
    const stats = tally(decided);
    const coverage = n ? decided.length / n : 0;
    const row = {
      threshold: th,
      lo,
      hi,
      n,
      answered: decided.length,
      abstained,
      coverage,
      fallbackRate: n ? abstained / n : 0,
      ...stats,
      positiveRate: decided.length ? (stats.tp + stats.fp) / decided.length : 0,
    };
    if (fb) {
      const b = tally(blendedPairs);
      row.blended = { precision: b.precision, recall: b.recall, f1: b.f1, accuracy: b.accuracy, n: blendedPairs.length, fallbackMissing };
    }
    if (opts.costs) row.costPer1k = costPer1k({ coverage, ...opts.costs });
    return row;
  });
}

/**
 * Varredura SELETIVA (limiar de certeza). items = [{certainty, correct, fallbackCorrect?}]:
 * aceita a resposta primária quando certainty >= τ. Linha: {threshold, n, accepted, coverage,
 * fallbackRate, accAccepted, accAcceptedCI, blendedAcc, costPer1k?, lowN}.
 * blendedAcc = (acertos aceitos + acertos do fallback nos rejeitados) / n. Sem `fallbackCorrect`
 * no item, usa opts.fallbackAccuracy (g_low: a acurácia do Gemini MEDIDA nos itens de baixa
 * certeza) — sem nenhum dos dois, blendedAcc = null. `lowN` marca aceitos < opts.minN (30).
 */
export function selectiveSweep(items, thresholds, opts = {}) {
  const minN = opts.minN ?? 30;
  const valid = items.filter((it) => toBool(it.correct) !== null);
  return thresholds.map((tau) => {
    let accepted = 0;
    let correctAccepted = 0;
    let fbKnown = 0;
    let fbCorrect = 0;
    let rejected = 0;
    for (const it of valid) {
      const c = Number(it.certainty);
      if (Number.isFinite(c) && c >= tau) {
        accepted++;
        if (toBool(it.correct)) correctAccepted++;
      } else {
        rejected++;
        const f = toBool(it.fallbackCorrect);
        if (f !== null) {
          fbKnown++;
          if (f) fbCorrect++;
        }
      }
    }
    const n = valid.length;
    const coverage = n ? accepted / n : 0;
    const ci = wilson(correctAccepted, accepted);
    let blendedAcc = null;
    if (n && rejected === 0) blendedAcc = correctAccepted / n;
    else if (n && fbKnown === rejected) blendedAcc = (correctAccepted + fbCorrect) / n;
    else if (n && Number.isFinite(opts.fallbackAccuracy)) {
      // Mistura: onde há resposta do fallback usa-a; o resto vale a acurácia medida g_low.
      blendedAcc = (correctAccepted + fbCorrect + (rejected - fbKnown) * opts.fallbackAccuracy) / n;
    }
    const row = {
      threshold: tau,
      n,
      accepted,
      coverage,
      fallbackRate: n ? rejected / n : 0,
      accAccepted: accepted ? correctAccepted / accepted : null,
      accAcceptedCI: { lo: ci.lo, hi: ci.hi },
      blendedAcc,
      lowN: accepted < minN,
    };
    if (opts.costs) row.costPer1k = costPer1k({ coverage, ...opts.costs });
    return row;
  });
}

// Métrica por caminho pontilhado ('f1', 'blended.f1', 'blendedAcc').
const metricOf = (row, metric) => metric.split('.').reduce((o, k) => (o == null ? undefined : o[k]), row);

/**
 * Escolhe o limiar numa lista de linhas de sweep/selectiveSweep.
 * pickThreshold(rows, 'f1', 0.8) ou pickThreshold(rows, {metric, minCoverage, target}).
 * - Sem `target`: maior métrica entre as linhas com coverage >= minCoverage (desempate: mais
 *   cobertura = menos fallback pago).
 * - Com `target` (ex.: a qualidade DeepSeek): a linha MAIS BARATA que atinge o alvo (menor
 *   costPer1k se houver, senão maior coverage; desempate pela métrica). Nenhuma atinge → a de
 *   melhor métrica com met:false (o relatório sinaliza, não esconde).
 * Devolve {row, threshold, met, reason} (row null se nenhuma linha é elegível).
 */
export function pickThreshold(rows, metricOrOpts = 'f1', minCoverage = 0) {
  const o =
    typeof metricOrOpts === 'string'
      ? { metric: metricOrOpts, minCoverage, target: null }
      : { metric: 'f1', minCoverage: 0, target: null, ...metricOrOpts };
  const eligible = (rows || []).filter(
    (r) => (r.coverage ?? 1) >= o.minCoverage && Number.isFinite(metricOf(r, o.metric)),
  );
  if (!eligible.length) return { row: null, threshold: null, met: false, reason: 'no-eligible' };
  const byMetric = (a, b) => metricOf(b, o.metric) - metricOf(a, o.metric) || (b.coverage ?? 1) - (a.coverage ?? 1);
  if (o.target != null) {
    const ok = eligible.filter((r) => metricOf(r, o.metric) >= o.target);
    if (ok.length) {
      const cheapest = ok.slice().sort((a, b) => {
        const ca = Number.isFinite(a.costPer1k) ? a.costPer1k : -(a.coverage ?? 1);
        const cb = Number.isFinite(b.costPer1k) ? b.costPer1k : -(b.coverage ?? 1);
        return ca - cb || metricOf(b, o.metric) - metricOf(a, o.metric);
      })[0];
      return { row: cheapest, threshold: cheapest.threshold, met: true, reason: 'cheapest-meeting-target' };
    }
    const best = eligible.slice().sort(byMetric)[0];
    return { row: best, threshold: best.threshold, met: false, reason: 'target-not-met' };
  }
  const best = eligible.slice().sort(byMetric)[0];
  return { row: best, threshold: best.threshold, met: true, reason: 'best-metric' };
}

// ---- calibração de probabilidade ----

/**
 * ECE (expected calibration error) com `bins` faixas iguais em [0,1]; p=1 cai na última.
 * probs = probabilidade prevista do positivo (ou a confiança da resposta), labels = se foi
 * positivo (ou se acertou). Devolve {ece, mce, n, bins:[{lo,hi,n,meanProb,accuracy,gap}]}.
 */
export function ece(probs, labels, bins = 10) {
  if (probs.length !== labels.length) throw new Error('ece: probs e labels com tamanhos diferentes');
  const acc = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, sumP: 0, sumY: 0 }));
  let n = 0;
  for (let i = 0; i < probs.length; i++) {
    const y = toBool(labels[i]);
    const p = Number(probs[i]);
    if (y === null || !Number.isFinite(p)) continue;
    const pc = Math.min(1, Math.max(0, p));
    const b = acc[Math.min(bins - 1, Math.floor(pc * bins))];
    b.n++;
    b.sumP += pc;
    b.sumY += y ? 1 : 0;
    n++;
  }
  let e = 0;
  let m = 0;
  const out = acc.map((b) => {
    if (!b.n) return { lo: b.lo, hi: b.hi, n: 0, meanProb: null, accuracy: null, gap: null };
    const meanProb = b.sumP / b.n;
    const accuracy = b.sumY / b.n;
    const gap = Math.abs(accuracy - meanProb);
    e += (b.n / n) * gap;
    m = Math.max(m, gap);
    return { lo: b.lo, hi: b.hi, n: b.n, meanProb, accuracy, gap };
  });
  return { ece: n ? e : 0, mce: m, n, bins: out };
}

/** Brier score (erro quadrático médio da probabilidade); null sem itens válidos. */
export function brier(probs, labels) {
  let s = 0;
  let n = 0;
  for (let i = 0; i < probs.length; i++) {
    const y = toBool(labels[i]);
    const p = Number(probs[i]);
    if (y === null || !Number.isFinite(p)) continue;
    s += (p - (y ? 1 : 0)) ** 2;
    n++;
  }
  return n ? s / n : null;
}

/** AUROC por postos (empates com posto médio). null sem positivo ou sem negativo. */
export function auroc(scores, labels) {
  const pts = [];
  for (let i = 0; i < scores.length; i++) {
    const y = toBool(labels[i]);
    const s = Number(scores[i]);
    if (y !== null && Number.isFinite(s)) pts.push({ s, y });
  }
  const nPos = pts.filter((p) => p.y).length;
  const nNeg = pts.length - nPos;
  if (!nPos || !nNeg) return null;
  pts.sort((a, b) => a.s - b.s);
  let rankSumPos = 0;
  for (let i = 0; i < pts.length; ) {
    let j = i;
    while (j + 1 < pts.length && pts[j + 1].s === pts[i].s) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (pts[k].y) rankSumPos += avgRank;
    i = j + 1;
  }
  return (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

// ---- concordância multiclasse (ex.: veredito ok|suspect|junk) ----

/** Kappa de Cohen entre dois rotuladores (pares com null são ignorados). */
export function cohenKappa(a, b) {
  const pairs = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] != null && b[i] != null) pairs.push([String(a[i]), String(b[i])]);
  const n = pairs.length;
  if (!n) return null;
  const ca = new Map();
  const cb = new Map();
  let agree = 0;
  for (const [x, y] of pairs) {
    if (x === y) agree++;
    ca.set(x, (ca.get(x) || 0) + 1);
    cb.set(y, (cb.get(y) || 0) + 1);
  }
  const po = agree / n;
  let pe = 0;
  for (const [k, v] of ca) pe += (v / n) * ((cb.get(k) || 0) / n);
  return pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);
}

/**
 * Métricas multiclasse: {n, accuracy, macroPrecision, macroRecall, macroF1, macroClasses, perClass:
 * {c:{precision, recall, f1, support, absent}}, confusion:{gold:{pred:n}}, kappa}. `classes` fixa
 * as classes (senão, a união vista); pares com null são ignorados. As médias macro pulam as classes
 * `absent` (convenção no topo do arquivo); `macroClasses` = quantas entraram.
 */
export function multiClassMetrics(pred, gold, { classes = null } = {}) {
  const pairs = [];
  for (let i = 0; i < Math.min(pred.length, gold.length); i++) {
    if (pred[i] != null && gold[i] != null) pairs.push([String(pred[i]), String(gold[i])]);
  }
  const cls = classes ? classes.map(String) : [...new Set(pairs.flat())].sort();
  const confusion = Object.fromEntries(cls.map((g) => [g, Object.fromEntries(cls.map((p) => [p, 0]))]));
  let correct = 0;
  for (const [p, g] of pairs) {
    if (p === g) correct++;
    confusion[g] ??= {};
    confusion[g][p] = (confusion[g][p] || 0) + 1;
  }
  const perClass = {};
  for (const c of cls) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const [p, g] of pairs) {
      if (p === c && g === c) tp++;
      else if (p === c) fp++;
      else if (g === c) fn++;
    }
    perClass[c] = { ...prf({ tp, fp, fn }), support: tp + fn, absent: tp + fp + fn === 0 };
  }
  const { mean, used } = macroMean(Object.values(perClass));
  return {
    n: pairs.length,
    accuracy: pairs.length ? correct / pairs.length : 0,
    macroPrecision: mean('precision'),
    macroRecall: mean('recall'),
    macroF1: mean('f1'),
    macroClasses: used,
    perClass,
    confusion,
    kappa: cohenKappa(pairs.map((x) => x[0]), pairs.map((x) => x[1])),
  };
}

/**
 * Média macro sobre as entradas NÃO ausentes (`absent` = sem gold e sem previsão). Todas ausentes →
 * média sobre todas (o acerto vazio); lista vazia → 0. Devolve { mean(k), used }.
 */
function macroMean(entries) {
  const scored = entries.filter((v) => !v.absent);
  const pool = scored.length ? scored : entries;
  return {
    used: scored.length,
    mean: (k) => (pool.length ? pool.reduce((s, v) => s + v[k], 0) / pool.length : 0),
  };
}

// ---- concordância multirrótulo (tags por faceta) ----

const asSet = (xs) => new Set([...(xs || [])].map(String));

/** Jaccard de dois conjuntos; os dois vazios = 1 (concordam que não há tag). */
export function jaccard(a, b) {
  const A = asSet(a);
  const B = asSet(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** P/R/F1 + Jaccard de UM par de conjuntos (previsto vs gold). */
export function setMetrics(pred, gold) {
  const P = asSet(pred);
  const G = asSet(gold);
  let tp = 0;
  for (const x of P) if (G.has(x)) tp++;
  const fp = P.size - tp;
  const fn = G.size - tp;
  return { tp, fp, fn, ...prf({ tp, fp, fn }), jaccard: jaccard(P, G) };
}

/**
 * Concordância multirrótulo por faceta. pred/gold = arrays ALINHADOS de {faceta: [tags]} (a
 * ordem das tags importa só p/ o top1). Por faceta: P/R/F1 MICRO (somando tp/fp/fn dos itens),
 * sampleF1 (média do F1 por item), meanJaccard, exact (conjuntos idênticos), emptyAgreement
 * (os dois vazios ou os dois não-vazios) e top1 (1ª tag prevista ∈ gold, entre itens com as duas
 * listas não-vazias; `top1N` = quantos). Geral: micro (soma de todas as facetas), macroF1 (média
 * entre as facetas NÃO ausentes — faceta sem tag nos dois lados fica `absent: true`, fora dela; ver
 * o topo do arquivo), macroFacets (quantas entraram) e meanJaccard (média entre TODAS as facetas: o
 * vazio×vazio = 1 ali é concordância de verdade, "nenhuma tag").
 */
export function multiLabelAgreement(pred, gold, { facets = null } = {}) {
  if (pred.length !== gold.length) throw new Error('multiLabelAgreement: pred e gold com tamanhos diferentes');
  const names =
    facets ||
    [...new Set([...pred, ...gold].flatMap((m) => Object.keys(m || {})))].sort();
  const perFacet = {};
  let TP = 0;
  let FP = 0;
  let FN = 0;
  for (const f of names) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let jac = 0;
    let exact = 0;
    let empty = 0;
    let sf1 = 0;
    let top1 = 0;
    let top1N = 0;
    for (let i = 0; i < gold.length; i++) {
      const p = (pred[i] || {})[f] || [];
      const g = (gold[i] || {})[f] || [];
      const m = setMetrics(p, g);
      tp += m.tp;
      fp += m.fp;
      fn += m.fn;
      jac += m.jaccard;
      sf1 += m.f1;
      if (m.fp === 0 && m.fn === 0) exact++;
      if (!p.length === !g.length) empty++;
      if (p.length && g.length) {
        top1N++;
        if (asSet(g).has(String(p[0]))) top1++;
      }
    }
    const n = gold.length;
    TP += tp;
    FP += fp;
    FN += fn;
    perFacet[f] = {
      n,
      tp,
      fp,
      fn,
      ...prf({ tp, fp, fn }),
      sampleF1: n ? sf1 / n : 0,
      meanJaccard: n ? jac / n : 0,
      exact: n ? exact / n : 0,
      emptyAgreement: n ? empty / n : 0,
      top1: top1N ? top1 / top1N : null,
      top1N,
      absent: tp + fp + fn === 0,
    };
  }
  const vals = Object.values(perFacet);
  const mean = (k) => (vals.length ? vals.reduce((s, v) => s + v[k], 0) / vals.length : 0);
  const macro = macroMean(vals);
  return {
    facets: perFacet,
    micro: { tp: TP, fp: FP, fn: FN, ...prf({ tp: TP, fp: FP, fn: FN }) },
    macroF1: macro.mean('f1'),
    macroFacets: macro.used,
    meanJaccard: mean('meanJaccard'),
  };
}

// ---- concordância sombra (produção: resposta do Jev vs a do Gemini nas decisões roteadas) ----

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Concordância por faixa de certeza a partir das linhas exportadas de jev_decisions
 * ({certainty, value, fbValue, agree?}). Linha sem `agree` e sem `fbValue` é ignorada. É a
 * entrada da recalibração da W8 a US$ 0.
 */
export function shadowAgreement(rows, { bins = 5, certaintyKey = 'certainty' } = {}) {
  const acc = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, agree: 0 }));
  let n = 0;
  let agree = 0;
  for (const r of rows || []) {
    const c = Number(r[certaintyKey]);
    if (!Number.isFinite(c)) continue;
    let ok = toBool(r.agree);
    if (ok === null) {
      if (r.fbValue === undefined || r.fbValue === null) continue;
      ok = sameValue(r.value, r.fbValue);
    }
    const b = acc[Math.min(bins - 1, Math.floor(Math.min(1, Math.max(0, c)) * bins))];
    b.n++;
    n++;
    if (ok) {
      b.agree++;
      agree++;
    }
  }
  return {
    n,
    rate: n ? agree / n : null,
    ci: wilson(agree, n),
    bins: acc.map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, rate: b.n ? b.agree / b.n : null, ci: wilson(b.agree, b.n) })),
  };
}
