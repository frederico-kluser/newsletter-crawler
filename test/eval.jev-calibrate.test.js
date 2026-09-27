// Infra do eval Jev (W0): funções puras de calibração (sweep/pickThreshold/ece/wilson/
// concordância), estabilidade da chave do cache, amostragem SOMENTE-LEITURA semeada, ledger
// isolado e os prompts DeepSeek CONGELADOS em eval/legacy (fingerprint = ninguém edita o baseline
// sem o teste gritar). Nada aqui chama rede, abre o NC_HOME real ou importa src/config.js/db.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  wilson, thresholdGrid, bandGrid, sweep, selectiveSweep, pickThreshold, ece, brier, auroc,
  cohenKappa, multiClassMetrics, jaccard, setMetrics, multiLabelAgreement, shadowAgreement,
  decideBand, costPer1k, prf,
} from '../eval/jev/lib/calibrate.mjs';
import { canonicalize, requestKey, createCache } from '../eval/jev/lib/cache.mjs';
import {
  resolveSourceDb, openSourceDb, seededOrder, seededSample, stratifiedSample, sampleVerifyRecords,
  sampleClassifiedArticles, sampleCuratedIssues, sampleSummaries, loadIssue, lengthBucket,
} from '../eval/jev/lib/sample.mjs';
import { LEDGER_DB, ledgerEnv, assertLedgerIsolation, summarizeUsageRows, summarizeLedger, formatLedgerSummary, utcMs } from '../eval/jev/lib/ledger.mjs';
import * as legacy from '../eval/legacy/index.mjs';

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const tmp = (prefix) => mkdtempSync(path.join(os.tmpdir(), prefix));

// ---------------------------------------------------------------- wilson / grades

test('wilson: valores conhecidos (z=1.96) e n=0 = intervalo [0,1]', () => {
  const w = wilson(5, 10);
  close(w.p, 0.5);
  close(w.lo, 0.2366);
  close(w.hi, 0.7634);
  const zero = wilson(0, 10);
  assert.equal(zero.lo, 0);
  close(zero.hi, 0.2775);
  const all = wilson(10, 10);
  assert.equal(all.hi, 1);
  close(all.lo, 0.7225);
  assert.deepEqual(wilson(0, 0), { k: 0, n: 0, p: 0, lo: 0, hi: 1 });
});

test('thresholdGrid: inclusiva e sem ruído de float; bandGrid só lo<hi', () => {
  const g = thresholdGrid(0.3, 0.95, 0.05);
  assert.equal(g.length, 14);
  assert.equal(g[0], 0.3);
  assert.equal(g[1], 0.35);
  assert.equal(g.at(-1), 0.95);
  assert.throws(() => thresholdGrid(0, 1, 0));
  assert.deepEqual(bandGrid([0.2, 0.5], [0.5, 0.8]), [{ lo: 0.2, hi: 0.5 }, { lo: 0.2, hi: 0.8 }, { lo: 0.5, hi: 0.8 }]);
});

test('prf: convenção de zero (acerto vazio = 1; um lado vazio = 0)', () => {
  assert.deepEqual(prf({ tp: 0, fp: 0, fn: 0 }), { precision: 1, recall: 1, f1: 1 });
  assert.deepEqual(prf({ tp: 0, fp: 0, fn: 2 }), { precision: 0, recall: 0, f1: 0 });
  assert.deepEqual(prf({ tp: 0, fp: 3, fn: 0 }), { precision: 0, recall: 0, f1: 0 }); // gold vazio, previsão não
});

// ---------------------------------------------------------------- sweep

test('sweep numérico: P/R/F1 por limiar, sem abstenção (coverage 1)', () => {
  const scores = [0.9, 0.8, 0.4, 0.2];
  const labels = [1, 0, 1, 0];
  const [at50, at85] = sweep(scores, labels, [0.5, 0.85]);
  assert.equal(at50.coverage, 1);
  assert.deepEqual([at50.tp, at50.fp, at50.fn, at50.tn], [1, 1, 1, 1]);
  assert.equal(at50.precision, 0.5);
  assert.equal(at50.recall, 0.5);
  assert.equal(at50.f1, 0.5);
  assert.equal(at85.precision, 1);
  assert.equal(at85.recall, 0.5);
  close(at85.f1, 2 / 3);
  assert.equal(at85.positiveRate, 0.25);
});

test('sweep em faixa {lo,hi}: incerto vira fallback; blended usa a resposta do fallback; custo', () => {
  const scores = [0.9, 0.8, 0.4, 0.2];
  const labels = [true, false, true, false];
  const [row] = sweep(scores, labels, [{ lo: 0.3, hi: 0.85 }], {
    fallback: [null, true, true, null], // 0.8 → fallback diz sim (gold não: FP); 0.4 → sim (gold sim: TP)
    costs: { primaryUsd: 0.001, fallbackUsd: 0.01 },
  });
  assert.equal(row.answered, 2);
  assert.equal(row.abstained, 2);
  assert.equal(row.coverage, 0.5);
  assert.equal(row.fallbackRate, 0.5);
  assert.equal(row.precision, 1);
  assert.equal(row.recall, 1);
  close(row.blended.precision, 2 / 3);
  assert.equal(row.blended.recall, 1);
  assert.equal(row.blended.accuracy, 0.75);
  assert.equal(row.blended.fallbackMissing, 0);
  close(row.costPer1k, 6); // 1000 × (0.001 + 0.5 × 0.01)
});

test('sweep: item sem gold é ignorado; score não-finito = abstenção; tamanhos diferentes lançam', () => {
  const [row] = sweep([0.9, NaN, 0.1, 0.7], [1, 1, null, 0], [0.5]);
  assert.equal(row.n, 3);
  assert.equal(row.abstained, 1);
  assert.equal(row.answered, 2);
  assert.throws(() => sweep([0.1], [1, 0], [0.5]));
  assert.equal(decideBand(0.5, { lo: 0.5, hi: 0.8 }), 'no'); // p <= lo → não
  assert.equal(decideBand(0.8, { lo: 0.5, hi: 0.8 }), 'yes'); // p >= hi → sim
  assert.equal(decideBand(0.6, { lo: 0.5, hi: 0.8 }), 'uncertain');
  assert.equal(costPer1k({ coverage: 1, primaryUsd: 0.0003, fallbackUsd: 1 }), 0.3);
});

test('selectiveSweep: cobertura, acurácia dos aceitos (Wilson), Q(τ) com fallback real ou g_low', () => {
  const items = [
    { certainty: 0.95, correct: true },
    { certainty: 0.9, correct: true },
    { certainty: 0.8, correct: false },
    { certainty: 0.4, correct: false, fallbackCorrect: true },
    { certainty: 0.2, correct: false, fallbackCorrect: false },
  ];
  const [r85, r50] = selectiveSweep(items, [0.85, 0.5], { minN: 2 });
  assert.equal(r85.accepted, 2);
  assert.equal(r85.coverage, 0.4);
  assert.equal(r85.accAccepted, 1);
  assert.equal(r85.lowN, false);
  assert.equal(r85.blendedAcc, null); // o item 0.8 rejeitado não tem fallbackCorrect e não há g_low
  assert.equal(r50.accepted, 3);
  close(r50.accAccepted, 2 / 3);
  assert.equal(r50.blendedAcc, 0.6); // (2 aceitos certos + 1 fallback certo) / 5
  const [withGlow] = selectiveSweep(items, [0.85], { fallbackAccuracy: 0.5, costs: { primaryUsd: 0, fallbackUsd: 0.01 } });
  close(withGlow.blendedAcc, (2 + 1 + 1 * 0.5) / 5);
  close(withGlow.costPer1k, 6);
  assert.ok(withGlow.accAcceptedCI.lo > 0 && withGlow.accAcceptedCI.hi === 1);
  assert.equal(selectiveSweep(items, [0.5])[0].lowN, true); // minN default 30
});

// ---------------------------------------------------------------- pickThreshold

test('pickThreshold: melhor métrica, minCoverage, alvo = o mais barato que atinge, alvo não atingido', () => {
  const rows = [
    { threshold: 0.5, coverage: 1.0, f1: 0.8, blended: { f1: 0.8 } },
    { threshold: 0.7, coverage: 0.8, f1: 0.88, blended: { f1: 0.9 } },
    { threshold: 0.9, coverage: 0.5, f1: 0.95, blended: { f1: 0.93 } },
  ];
  assert.equal(pickThreshold(rows, 'f1').threshold, 0.9);
  assert.equal(pickThreshold(rows, 'f1', 0.75).threshold, 0.7);
  const hit = pickThreshold(rows, { metric: 'blended.f1', target: 0.89 });
  assert.equal(hit.threshold, 0.7); // 0.9 também atinge, mas cobre menos (mais fallback pago)
  assert.equal(hit.met, true);
  const miss = pickThreshold(rows, { metric: 'blended.f1', target: 0.99 });
  assert.equal(miss.met, false);
  assert.equal(miss.threshold, 0.9);
  assert.equal(pickThreshold(rows, 'f1', 1.01).row, null);
  assert.equal(pickThreshold([], 'f1').reason, 'no-eligible');
  // com costPer1k o "mais barato" é o de menor custo, não o de maior cobertura
  const costed = [
    { threshold: 0.6, coverage: 0.9, f1: 0.9, costPer1k: 5 },
    { threshold: 0.8, coverage: 0.95, f1: 0.9, costPer1k: 7 },
  ];
  assert.equal(pickThreshold(costed, { metric: 'f1', target: 0.85 }).threshold, 0.6);
});

test('pickThreshold integra com sweep (mesma forma de linha)', () => {
  const scores = [0.95, 0.9, 0.7, 0.6, 0.3, 0.1];
  const labels = [1, 1, 1, 0, 0, 0];
  const rows = sweep(scores, labels, thresholdGrid(0.5, 0.9, 0.1));
  const pick = pickThreshold(rows, 'f1');
  assert.equal(pick.row.f1, 1);
  assert.equal(pick.threshold, 0.7);
});

// ---------------------------------------------------------------- ece / brier / auroc

test('ece: calibrado = 0, descalibrado = gap, pesos por bin, p=1 na última faixa', () => {
  assert.equal(ece([0.25, 0.25, 0.25, 0.25], [1, 0, 0, 0], 4).ece, 0);
  close(ece([0.9, 0.9], [0, 0]).ece, 0.9);
  const mixed = ece([0.1, 0.1, 0.9, 0.9], [0, 0, 1, 0], 10);
  close(mixed.ece, 0.25);
  close(mixed.mce, 0.4);
  assert.equal(mixed.n, 4);
  const edge = ece([1, 0], [1, 0], 10);
  assert.equal(edge.bins[9].n, 1);
  assert.equal(edge.bins[0].n, 1);
  assert.equal(edge.ece, 0);
  assert.equal(ece([], []).ece, 0);
  assert.throws(() => ece([0.5], []));
});

test('brier e auroc: separação perfeita, invertida, empate e classe única', () => {
  assert.equal(brier([1, 0], [1, 0]), 0);
  close(brier([0.5, 0.5], [1, 0]), 0.25);
  assert.equal(brier([], []), null);
  assert.equal(auroc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0]), 1);
  assert.equal(auroc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0]), 0);
  assert.equal(auroc([0.5, 0.5], [1, 0]), 0.5);
  assert.equal(auroc([0.3, 0.4], [1, 1]), null);
});

// ---------------------------------------------------------------- concordância

test('multiClassMetrics + kappa: veredito ok|suspect|junk', () => {
  const gold = ['ok', 'ok', 'suspect', 'junk', 'junk'];
  const pred = ['ok', 'suspect', 'suspect', 'junk', 'ok'];
  const m = multiClassMetrics(pred, gold, { classes: ['ok', 'suspect', 'junk'] });
  assert.equal(m.n, 5);
  close(m.accuracy, 0.6);
  assert.equal(m.perClass.junk.precision, 1);
  assert.equal(m.perClass.junk.recall, 0.5);
  assert.equal(m.perClass.suspect.support, 1);
  assert.equal(m.confusion.junk.ok, 1);
  close(m.macroF1, (0.5 + 2 / 3 + 2 / 3) / 3);
  assert.equal(m.macroClasses, 3);
  // Classe AUSENTE dos dois lados fica fora da média macro: o MESMO erro custa o mesmo, caia onde cair.
  const g2 = ['ok', 'ok', 'suspect', 'suspect'];
  const cls = { classes: ['ok', 'suspect', 'junk'] };
  const perfect = multiClassMetrics(g2, g2, cls);
  assert.equal(perfect.macroF1, 1);
  assert.equal(perfect.perClass.junk.absent, true);
  assert.equal(perfect.macroClasses, 2);
  const errToOk = multiClassMetrics(['ok', 'ok', 'ok', 'suspect'], g2, cls);
  const errToJunk = multiClassMetrics(['ok', 'ok', 'junk', 'suspect'], g2, cls);
  assert.equal(errToJunk.perClass.junk.absent, false, 'uma previsão tira a classe da ausência');
  // junk ausente em errToOk: a média é sobre ok (F1 0.8) e suspect (2/3) — o acerto vazio da junk
  // (F1 = 1) NÃO a infla (antes: (0.8 + 2/3 + 1)/3 ≈ 0.822, e o degrau p/ errToJunk era 1/3 inteiro).
  close(errToOk.macroF1, (0.8 + 2 / 3) / 2);
  assert.equal(errToOk.macroClasses, 2);
  close(errToJunk.macroF1, (1 + 2 / 3 + 0) / 3);
  assert.ok(errToJunk.macroF1 < errToOk.macroF1, 'previsão numa classe que não existe no gold segue pior');
  assert.equal(multiClassMetrics([], [], cls).macroF1, 1, 'tudo ausente: acerto vazio');
  assert.equal(cohenKappa(['a', 'b', 'a'], ['a', 'b', 'a']), 1);
  assert.equal(cohenKappa([], []), null);
  close(cohenKappa(['a', 'a', 'b', 'b'], ['a', 'b', 'a', 'b']), 0);
});

test('jaccard/setMetrics: vazio×vazio = 1; parcial', () => {
  assert.equal(jaccard([], []), 1);
  close(jaccard(['a', 'b'], ['b', 'c']), 1 / 3);
  const s = setMetrics(['a', 'b'], ['b', 'c', 'd']);
  assert.deepEqual([s.tp, s.fp, s.fn], [1, 1, 2]);
  assert.equal(s.precision, 0.5);
  close(s.recall, 1 / 3);
});

test('multiLabelAgreement: P/R/F1 micro por faceta, Jaccard, exact, top1, vazio, macro', () => {
  const gold = [
    { domain: ['nodejs'], 'topic-technology': ['nodejs', 'performance'] },
    { domain: ['rust'], 'topic-technology': [] },
  ];
  const pred = [
    { domain: ['nodejs'], 'topic-technology': ['performance', 'wasm'] },
    { domain: ['go'], 'topic-technology': [] },
  ];
  const a = multiLabelAgreement(pred, gold, { facets: ['domain', 'topic-technology'] });
  const d = a.facets.domain;
  assert.deepEqual([d.tp, d.fp, d.fn], [1, 1, 1]);
  assert.equal(d.f1, 0.5);
  assert.equal(d.exact, 0.5);
  assert.equal(d.top1, 0.5);
  assert.equal(d.top1N, 2);
  assert.equal(d.meanJaccard, 0.5);
  const t = a.facets['topic-technology'];
  assert.deepEqual([t.tp, t.fp, t.fn], [1, 1, 1]);
  close(t.meanJaccard, (1 / 3 + 1) / 2); // item 2: vazio×vazio = 1
  assert.equal(t.emptyAgreement, 1);
  assert.equal(t.top1, 1); // 'performance' ∈ gold do item 1; item 2 fora (listas vazias)
  assert.deepEqual([a.micro.tp, a.micro.fp, a.micro.fn], [2, 2, 2]);
  assert.equal(a.macroF1, 0.5);
  assert.equal(a.macroFacets, 2);
  // faceta vazia nos DOIS lados em todo item: fora do macroF1 (senão F1 = 1 inflaria a média)
  const withEmpty = multiLabelAgreement(pred, gold, { facets: ['domain', 'topic-technology', 'audience'] });
  assert.equal(withEmpty.facets.audience.absent, true);
  assert.equal(withEmpty.macroF1, 0.5, 'a faceta ausente não entra na média');
  assert.equal(withEmpty.macroFacets, 2);
  close(withEmpty.meanJaccard, (a.meanJaccard * 2 + 1) / 3); // no Jaccard o vazio×vazio conta (concordância real)
  // facetas inferidas pela união das chaves quando não informadas
  assert.deepEqual(Object.keys(multiLabelAgreement(pred, gold).facets), ['domain', 'topic-technology']);
  assert.throws(() => multiLabelAgreement([{}], []));
});

test('shadowAgreement: concordância por faixa de certeza (agree explícito ou value×fbValue)', () => {
  const rows = [
    { certainty: 0.95, value: 'ok', fbValue: 'ok' },
    { certainty: 0.9, value: ['a', 'b'], fbValue: ['a', 'b'] },
    { certainty: 0.1, value: 'ok', fbValue: 'junk' },
    { certainty: 0.15, agree: true },
    { certainty: 0.5, value: 'x' }, // sem fbValue nem agree: ignorada
  ];
  const s = shadowAgreement(rows, { bins: 2 });
  assert.equal(s.n, 4);
  assert.equal(s.rate, 0.75);
  assert.equal(s.bins[1].n, 2);
  assert.equal(s.bins[1].rate, 1);
  assert.equal(s.bins[0].rate, 0.5);
});

// ---------------------------------------------------------------- cache

test('requestKey: estável à ordem das chaves, sensível a conteúdo, ignora undefined/função', () => {
  const a = { model: 'typesafe/jev-1.13', stage: 'verifyRecordJev', state: { b: 1, a: [1, { y: 2, x: 1 }] }, questions: [{ id: 'q1' }] };
  const b = { questions: [{ id: 'q1' }], state: { a: [1, { x: 1, y: 2 }], b: 1 }, stage: 'verifyRecordJev', model: 'typesafe/jev-1.13' };
  assert.equal(requestKey(a), requestKey(b));
  assert.match(requestKey(a), /^[0-9a-f]{64}$/);
  assert.notEqual(requestKey(a), requestKey({ ...a, model: 'typesafe/jev-1.14' }));
  assert.notEqual(requestKey({ q: [1, 2] }), requestKey({ q: [2, 1] })); // ordem de array importa
  assert.equal(requestKey({ a: 1, b: undefined, f: () => 1 }), requestKey({ a: 1 }));
  assert.equal(requestKey({ z: -0 }), requestKey({ z: 0 }));
  assert.equal(canonicalize({ b: [undefined, 2], a: NaN }), '{"a":null,"b":[null,2]}');
  // fixado: se a canonização mudar, todo o cache pago existente vira miss — tem que ser de propósito
  assert.equal(requestKey({ b: 2, a: 1 }), '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
  assert.throws(() => requestKey(undefined));
});

test('createCache: put/get/has, getOrCompute hit×miss, erro nunca cacheado, entrada corrompida = miss', async () => {
  const dir = tmp('nc-evalcache-');
  try {
    const cache = createCache({ dir, namespace: 'verify:Jev' });
    const req = { stage: 's', q: 1 };
    assert.equal(cache.has(req), false);
    assert.equal(cache.get(req), undefined);
    cache.put(req, { answers: { q1: { p: 0.9 } } }, { costUsd: 0.0003 });
    assert.equal(cache.has(req), true);
    assert.deepEqual(cache.get({ q: 1, stage: 's' }), { answers: { q1: { p: 0.9 } } });
    assert.equal(cache.getEntry(req).meta.costUsd, 0.0003);
    assert.ok(cache.pathOf(req).includes(path.join('verify_Jev', requestKey(req).slice(0, 2))));
    let calls = 0;
    const compute = async () => {
      calls++;
      return { v: calls };
    };
    const miss = await cache.getOrCompute({ n: 2 }, compute);
    const hit = await cache.getOrCompute({ n: 2 }, compute);
    assert.equal(miss.hit, false);
    assert.equal(hit.hit, true);
    assert.deepEqual(hit.value, { v: 1 });
    assert.equal(calls, 1);
    await assert.rejects(cache.getOrCompute({ n: 3 }, async () => { throw new Error('429'); }), /429/);
    assert.equal(cache.has({ n: 3 }), false);
    writeFileSync(cache.pathOf(req), '{"key": trunc');
    assert.equal(cache.get(req), undefined);
    assert.equal(cache.size(), 2);
    assert.equal(cache.delete({ n: 2 }), true);
    assert.equal(cache.delete({ n: 2 }), false);
    assert.throws(() => cache.put({ n: 4 }, undefined));
    assert.deepEqual(cache.stats().writes, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- amostragem

test('seededOrder/seededSample: determinístico, independe da ordem de entrada, seed muda a amostra', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
  const a = seededSample(items, 10, 'w3');
  const b = seededSample(items.slice().reverse(), 10, 'w3');
  assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
  assert.notDeepEqual(a.map((x) => x.id), seededSample(items, 10, 'w4').map((x) => x.id));
  assert.equal(seededOrder(items, 'w3').length, 50);
  assert.equal(seededSample(items, Infinity, 'w3').length, 50);
  const { items: picked, shortfall } = stratifiedSample(
    items.map((x) => ({ ...x, g: x.id <= 5 ? 'junk' : 'ok' })),
    { strataOf: (x) => x.g, quotas: { ok: 3, junk: 8 }, seed: 's' },
  );
  assert.deepEqual(picked.map((x) => x.stratum), ['ok', 'ok', 'ok', 'junk', 'junk', 'junk', 'junk', 'junk']);
  assert.deepEqual(shortfall, { junk: { want: 8, got: 5 } });
  assert.equal(lengthBucket(100), 'short');
  assert.equal(lengthBucket(7000), 'long');
});

test('resolveSourceDb: EVAL_SOURCE_DB > NC_HOME/crawler.db', () => {
  assert.equal(resolveSourceDb({ EVAL_SOURCE_DB: '/x/y.db', NC_HOME: '/h' }), '/x/y.db');
  assert.equal(resolveSourceDb({ NC_HOME: '/h' }), path.join('/h', 'crawler.db'));
  assert.equal(resolveSourceDb({}), path.join(os.homedir(), '.newsletter-crawler', 'crawler.db'));
});

// Banco de mentira com o schema mínimo que os amostradores leem (criado aqui, em tmpdir).
function makeSourceDb(file) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT, base_url TEXT, type TEXT);
    CREATE TABLE articles (id INTEGER PRIMARY KEY, source_id INTEGER, url TEXT, title TEXT, content TEXT,
      published_at TEXT, kind TEXT, section TEXT, blurb TEXT, issue_url TEXT, verify_status TEXT,
      verify_notes TEXT, title_pt TEXT, summary_pt TEXT, run_id INTEGER, content_source TEXT);
    CREATE TABLE article_tags (article_id INTEGER, facet TEXT, tag TEXT, rank INTEGER);
  `);
  db.prepare("INSERT INTO sources VALUES (1, 'Node Weekly', 'https://nodeweekly.com/issues', 'index'), (2, 'Blog', 'https://b.test', 'listing')").run();
  const ins = db.prepare(
    'INSERT INTO articles (id, source_id, url, title, content, published_at, kind, section, verify_status, title_pt, summary_pt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  );
  const verdicts = ['ok', 'ok', 'suspect', 'junk'];
  for (let i = 1; i <= 40; i++) {
    const src = i <= 30 ? 1 : 2;
    const date = src === 1 ? `2026-08-${String(1 + Math.floor((i - 1) / 10)).padStart(2, '0')}` : '2026-08-20';
    ins.run(i, src, `https://x.test/${i}`, `T${i}`, 'c'.repeat(i * 200), date, i % 3 ? 'news' : 'tool', src === 1 ? 'IN BRIEF' : null, verdicts[i % 4], `T${i} pt`, i % 5 ? `resumo ${i}` : null);
  }
  const tag = db.prepare('INSERT INTO article_tags VALUES (?,?,?,?)');
  for (let i = 1; i <= 20; i++) {
    tag.run(i, 'domain', i % 2 ? 'nodejs' : 'rust', 0);
    tag.run(i, 'topic-technology', 'performance', 1);
    tag.run(i, 'topic-technology', 'wasm', 0);
  }
  db.close();
}

test('openSourceDb: SOMENTE-LEITURA de verdade (escrita lança) + amostradores com gold', () => {
  const dir = tmp('nc-evalsrc-');
  const file = path.join(dir, 'crawler.db');
  try {
    makeSourceDb(file);
    assert.throws(() => openSourceDb(path.join(dir, 'nao-existe.db'))); // fileMustExist: nunca cria
    assert.equal(existsSync(path.join(dir, 'nao-existe.db')), false);
    const db = openSourceDb(file);
    assert.throws(() => db.prepare("UPDATE articles SET title = 'x'").run(), /readonly|query_only|read-only/i);

    const v = sampleVerifyRecords(db, { quotas: { ok: 3, suspect: 2, junk: 20 }, seed: 't' });
    assert.equal(v.records.length, 3 + 2 + 10);
    assert.ok(v.records.every((r) => r.gold === r.verify_status && r.stratum === r.gold));
    assert.deepEqual(v.shortfall, { junk: { want: 20, got: 10 } });
    const v2 = sampleVerifyRecords(db, { quotas: { ok: 3, suspect: 2, junk: 20 }, seed: 't' });
    assert.deepEqual(v2.records.map((r) => r.id), v.records.map((r) => r.id)); // determinístico
    assert.equal(sampleVerifyRecords(db, { n: 5, maxContentChars: 10 }).records[0].content.length, 10);

    const c = sampleClassifiedArticles(db, { perStratum: 3, seed: 't' });
    assert.deepEqual(c.records.map((r) => r.stratum), ['nodejs', 'nodejs', 'nodejs', 'rust', 'rust', 'rust']);
    assert.deepEqual(c.records[0].tags['topic-technology'], ['wasm', 'performance']); // ordem por rank
    assert.ok(c.records.every((r) => r.goldKind === r.kind));
    assert.equal(sampleClassifiedArticles(db, { n: 100, onlyVerifiedOk: true }).records.every((r) => r.verify_status === 'ok'), true);

    const issues = sampleCuratedIssues(db, { n: 10, types: ['index'] });
    assert.equal(issues.length, 3); // 3 datas × 10 itens na fonte index; a listing (sem seção) fica fora
    assert.ok(issues.every((i) => i.source === 'Node Weekly' && i.items.length === 10));
    assert.equal(sampleCuratedIssues(db, { sources: ['Node Weekly'], minItems: 11 }).length, 0);
    assert.equal(loadIssue(db, { sourceId: 1, publishedAt: '2026-08-02' }).items[0].id, 11);

    const s = sampleSummaries(db, { quotas: { short: 2, long: 2 }, seed: 't' });
    assert.deepEqual(s.records.map((r) => r.stratum), ['short', 'short', 'long', 'long']);
    assert.ok(s.records.every((r) => r.summary_pt && r.title_pt));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- ledger

test('ledgerEnv/assertLedgerIsolation: DB_PATH absoluto no ledger, OpenRouter, recusa override', () => {
  const base = { NC_HOME: '/h', DB_PATH: 'crawler.db', LLM_PROVIDER: 'deepseek' };
  const env = ledgerEnv(base);
  assert.equal(env.DB_PATH, LEDGER_DB);
  assert.ok(path.isAbsolute(env.DB_PATH) && env.DB_PATH.endsWith(path.join('eval', 'jev', '.ledger.db')));
  assert.equal(env.LLM_PROVIDER, 'openrouter');
  assert.equal(env.NC_HOME, '/h');
  assert.equal(base.DB_PATH, 'crawler.db'); // não muta o env de origem
  assert.equal(assertLedgerIsolation({ dbPath: LEDGER_DB }), true);
  assert.throws(() => assertLedgerIsolation({ dbPath: '/h/crawler.db' }), /ledger/);
  assert.throws(() => assertLedgerIsolation({ dbPath: LEDGER_DB, provider: 'deepseek' }), /openrouter/);
});

test('summarizeUsageRows/summarizeLedger: agrega por etapa/engine/run; ledger ausente = vazio', () => {
  const rows = [
    { run_id: 1, stage: 'verifyRecordJev', model: 'typesafe/jev-1.13', prompt_tokens: 2000, completion_tokens: 10, cost_usd: 0.0001, engine: 'jev', decisions: 13, latency_ms: 400 },
    { run_id: 1, stage: 'verifyRecord', model: 'google/gemini-3.8-flash', prompt_tokens: 1500, completion_tokens: 300, cost_usd: 0.0022, engine: 'gemini', fallback_reason: 'low-confidence' },
    { run_id: 2, stage: 'legacy:curate', model: 'deepseek/deepseek-v4-flash-0731', prompt_tokens: 9000, completion_tokens: 900, cost_usd: 0.0005 },
  ];
  const s = summarizeUsageRows(rows);
  assert.equal(s.total.calls, 3);
  close(s.total.costUsd, 0.0028, 1e-9);
  assert.equal(s.byEngine.jev.decisions, 13);
  assert.equal(s.byEngine.jev.avgLatencyMs, 400);
  assert.equal(s.byEngine['(legado)'].calls, 1);
  assert.equal(s.byFallbackReason['low-confidence'].calls, 1);
  assert.equal(Object.keys(s.byStage)[0], 'verifyRecord'); // ordenado por custo
  assert.equal(summarizeUsageRows(rows, { runIds: [2] }).total.calls, 1);
  assert.equal(summarizeUsageRows(rows, { stagePrefix: 'verify' }).total.calls, 2);
  // since ISO completo × created_at do SQLite (espaço, UTC): compara INSTANTE, não texto
  const day = [{ run_id: 9, stage: 's', model: 'm', prompt_tokens: 1, completion_tokens: 0, cost_usd: 0.01, created_at: '2026-09-26 15:00:00' }];
  assert.equal(summarizeUsageRows(day, { since: '2026-09-26T10:00:00.000Z' }).total.calls, 1, 'mesmo dia, depois do since');
  assert.equal(summarizeUsageRows(day, { since: '2026-09-26T15:00:00Z' }).total.calls, 1, 'inclusivo');
  assert.equal(summarizeUsageRows(day, { since: '2026-09-26T16:00:00Z' }).total.calls, 0);
  assert.equal(summarizeUsageRows(day, { since: '2026-09-26T12:00:00-04:00' }).total.calls, 0, 'fuso explícito: 16:00Z');
  assert.equal(summarizeUsageRows(day, { since: '2026-09-26' }).total.calls, 1, 'só a data = meia-noite UTC');
  assert.equal(utcMs('2026-09-26 15:00:00'), Date.parse('2026-09-26T15:00:00Z'));
  assert.ok(Number.isNaN(utcMs('')));

  const dir = tmp('nc-evalledger-');
  try {
    const missing = summarizeLedger({ ledgerPath: path.join(dir, 'nada.db') });
    assert.equal(missing.exists, false);
    assert.equal(missing.total.calls, 0);
    const file = path.join(dir, '.ledger.db');
    const db = new Database(file);
    db.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, command TEXT, args TEXT, budget_usd REAL, status TEXT, started_at TEXT, finished_at TEXT);
      CREATE TABLE llm_usage (id INTEGER PRIMARY KEY, run_id INTEGER, stage TEXT, model TEXT, prompt_tokens INTEGER,
        completion_tokens INTEGER, cost_usd REAL, created_at TEXT, engine TEXT);`);
    db.prepare("INSERT INTO runs (id, command, budget_usd, status) VALUES (1, 'eval:verifyRecordJev', 0.05, 'done')").run();
    db.prepare("INSERT INTO llm_usage (run_id, stage, model, prompt_tokens, completion_tokens, cost_usd, created_at, engine) VALUES (1, 'verifyRecordJev', 'typesafe/jev-1.13', 100, 5, 0.00001, '2026-09-26 10:00:00', 'jev')").run();
    db.close();
    const got = summarizeLedger({ ledgerPath: file });
    assert.equal(got.exists, true);
    assert.equal(got.runs[0].command, 'eval:verifyRecordJev');
    assert.equal(got.byEngine.jev.calls, 1);
    assert.equal(summarizeLedger({ ledgerPath: file, since: '2026-09-27' }).total.calls, 0);
    // `since` ISO completo no MESMO dia: comparado como instante (o texto 'T' > ' ' derrubava a linha)
    assert.equal(summarizeLedger({ ledgerPath: file, since: '2026-09-26T09:00:00.000Z' }).total.calls, 1);
    assert.equal(summarizeLedger({ ledgerPath: file, since: '2026-09-26T10:00:01Z' }).total.calls, 0);
    assert.match(formatLedgerSummary(got)[0], /1 chamada\(s\), US\$ 0\.000010/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- prompts congelados

// Taxonomia mínima embutida: o fingerprint do classify não pode depender do config/taxonomy.json.
const MINI_TAX = {
  version: 'test',
  facets: { domain: ['nodejs', 'rust'], 'content-type': ['news', 'tool-release'], difficulty: ['beginner'] },
  topics_by_domain: { nodejs: ['nodejs', 'performance'], rust: ['rust'] },
  tools_by_domain: { nodejs: ['fastify'] },
  ai_engineering_cross: { topics: ['rag'], tools: ['langchain'] },
  aliases: { js: 'javascript', node: 'nodejs' },
  mandatory: ['domain', 'content-type'],
  limits: { domain: [1, 2], 'content-type': [1, 1], 'topic-technology': [1, 4] },
};
const FIXED_DETECT = { url: 'u', title: '', sig: { urlMatchesIndexPath: false, totalLinks: 0, internalLinks: 0, externalLinks: 0, issueLikeInternalLinks: 0, proseChars: 0 }, sampleLinks: [] };
const SPEC = { must_have: ['rust async'], nice_to_have: ['tokio'], query_en: 'rust async runtimes', terms: ['tokio'] };
// Entradas FIXAS de cada builder (mude aqui = mude o fingerprint, de propósito).
const FIXED = {
  curateRoundupItems: () => legacy.buildCurateRoundupRequest({ markdown: '# Node Weekly #638\n- [A](https://a.test) blurb', baseUrl: 'https://nodeweekly.com/issues/638', section: 'Code & Tools', part: '1/2' }),
  curateLeftoverLinks: () => legacy.buildCurateLeftoverRequest({ pageContext: '<p>page</p>', baseUrl: 'https://nodeweekly.com/issues/638', leftovers: [{ url: 'https://a.test', anchor: 'Demo' }, { url: 'https://b.test' }] }),
  cleanArticleContent: () => legacy.buildCleanArticleRequest({ title: 'X | npm Docs', content: 'Share\nreal text', stage: 'articleReclean' }),
  verifyRecordLLM: () => legacy.buildVerifyRecordRequest({ url: 'https://svgo.dev', kind: 'release', title: 'SVGO 4.1', blurb: null, content: 'Website • Docs' }),
  extractLinksItemByItem: () => legacy.buildExtractLinksRequest('<a href="/issues/1">1</a>'),
  extractRoundupLinks: () => legacy.buildExtractRoundupLinksRequest('<a href="https://a.test">A</a>', 'https://nodeweekly.com/issues/638'),
  extractArticleViaLLM: () => legacy.buildExtractArticleRequest('<h1>T</h1><p>body</p>'),
  judgeRelevance: () => legacy.buildRelevanceRequest({ query: 'rust async', title: 'Tokio 2.0', content: 'tokio runtime', spec: SPEC }),
  judgeRelevanceBatch: () => legacy.buildRelevanceBatchRequest({ query: 'rust async', items: [{ id: 1, title: 'Tokio 2.0', summary: 'runtime' }] }),
  compileQuerySpec: () => legacy.buildQuerySpecRequest('bibliotecas de runtime assíncrono em Rust'),
  classifyFacet: () => legacy.buildFacetRequest('topic-technology', { title: 'Node perf', content: 'nodejs performance' }, { taxonomy: MINI_TAX }),
  mapQueryToFacetTags: () => legacy.buildFacetQueryRequest('domain', 'node performance', { taxonomy: MINI_TAX }),
  detectType: () => legacy.buildDetectTypeRequest({ url: 'https://nodeweekly.com/issues', title: 'Node Weekly', sig: { urlMatchesIndexPath: true, totalLinks: 40, internalLinks: 35, externalLinks: 5, issueLikeInternalLinks: 30, proseChars: 200 }, sampleLinks: ['https://nodeweekly.com/issues/638'] }),
};
// sha256 canônico de {stage, schemaName, schema, system, user, model, effort}. Os 10 de src/llm.js
// batem com o body REAL que src/llm.js@421b42c montava p/ as mesmas entradas (fetch stubado, sem
// rede); classify/mapQueryToFacetTags/detectType usam taxonomia/sinais embutidos e tiveram o
// template conferido byte a byte nas 9 facetas reais e no texto de src/detect-type.js.
const FINGERPRINTS = {
  curateRoundupItems: 'df14a4a214542b1618b6b28f556b81aeabcc304d2887d2e588f8193833ca5523',
  curateLeftoverLinks: 'c312192bbea0b37a01ac5469684a66f0936d53ba8c89a13cdfafc75db8bdd7f7',
  cleanArticleContent: 'b843d1190a671a185606bd4ac81a2e3b2d43840308e75607ec2463e4070d14ed',
  verifyRecordLLM: '1ad98c2b2adc4593ed5473269dd608e0dfb7b0391dd3d0ea1947567f75a23f90',
  extractLinksItemByItem: 'c159df7bc93705ce216d4547f42da3a203105fc022e0ccf2008ca43b8755c5d9',
  extractRoundupLinks: '2f90d03b1052e5ee93ffee46ef073a0ea80f6163fa5c653ccb3b64abbf4b3d3d',
  extractArticleViaLLM: '2d3019bcd2de30f2399b70c50c36f3b419ddae1c815939427e31373f07a5aeca',
  judgeRelevance: '18a0e7d0082f8caacc0f047319a4b8f7277171e49610a99f9520bde0cda47438',
  judgeRelevanceBatch: '642ed63439adb8d2f461e27696319c6feae09a3d1c170b38f97c35a4e3bd4be3',
  compileQuerySpec: '85dfb0dfa0dbf1b1fdd16430ab02d7ecd937e7796694e8c7eba9db1d27f531bd',
  classifyFacet: 'bfb7ec35b3e6411a8cc5042ba9002c0b4e3d17c5dc1f07263741995f782b0421',
  mapQueryToFacetTags: 'a4c001daa7ba108c290d01240f060a8d90f9056a25b2e7cad23a391028bced25',
  detectType: 'b3c567138eb507ee1cc63e19c1066ace79cce4724e77c39f2b48502de482c626',
};
const fingerprint = (r) =>
  requestKey({ stage: r.stage, schemaName: r.schemaName, schema: r.schema, system: r.system, user: r.user, model: r.model, effort: r.effort });

test('legacy: todo builder devolve {system, user, schema, stage} + model/effort congelados + parse', () => {
  assert.deepEqual(Object.keys(FIXED).sort(), Object.keys(legacy.LEGACY_BUILDERS).sort());
  for (const [name, build] of Object.entries(FIXED)) {
    const r = build();
    for (const k of ['system', 'user', 'stage', 'schemaName', 'model', 'effort']) {
      assert.equal(typeof r[k], 'string', `${name}.${k}`);
    }
    assert.equal(r.schema.type, 'object', name);
    assert.equal(typeof r.parse, 'function', name);
    assert.equal(r.legacy, true);
    assert.equal(r.model, 'deepseek/deepseek-v4-flash-0731', name);
    assert.notEqual(r.effort, 'max', name); // DeepSeek V4 → 400
    const args = legacy.toCallJSONArgs(r);
    assert.equal(args.fallbackModel, null);
    assert.deepEqual(args.reasoning, { effort: r.effort });
    assert.equal(args.parse, undefined);
  }
  assert.equal(legacy.FROZEN_FROM.commit, '421b42c');
});

test('legacy: fingerprint fixo de cada prompt (editar o baseline congelado quebra aqui)', () => {
  const actual = Object.fromEntries(Object.entries(FIXED).map(([k, build]) => [k, fingerprint(build())]));
  assert.deepEqual(actual, FINGERPRINTS);
});

test('legacy: model/effort efetivos (articleReclean = xhigh; classify por faceta)', () => {
  assert.equal(legacy.buildCleanArticleRequest({ title: 't', content: 'c' }).effort, 'medium');
  assert.equal(legacy.buildCleanArticleRequest({ title: 't', content: 'c', stage: 'articleReclean' }).effort, 'xhigh');
  const art = { title: 't', content: 'c' };
  assert.equal(legacy.buildFacetRequest('domain', art, { taxonomy: MINI_TAX }).effort, 'high');
  assert.equal(legacy.buildFacetRequest('difficulty', art, { taxonomy: MINI_TAX }).effort, 'medium');
  assert.equal(legacy.buildFacetRequest('domain', art, { taxonomy: MINI_TAX, model: 'google/gemini-3.8-flash', effort: 'low' }).model, 'google/gemini-3.8-flash');
  assert.throws(() => legacy.buildFacetRequest('nope', art, { taxonomy: MINI_TAX }));
  assert.equal(legacy.buildVerifyRecordRequest({ url: 'u', content: 'x'.repeat(10) }, { maxChars: 3 }).user.endsWith('\nxxx'), true);
});

test('legacy: parse sem zod espelha os clamps/defaults tolerantes e o modo estrito', () => {
  const curate = legacy.buildCurateRoundupRequest({ markdown: 'm', baseUrl: 'u' });
  assert.deepEqual(curate.parse({ issue_date: null, items: [{ url: 'a', title: 'A', kind: ' TOOL ', section: null, blurb: 'b', x: 1 }] }), {
    issue_date: null,
    items: [{ url: 'a', title: 'A', kind: 'tool', section: null, blurb: 'b' }],
  });
  assert.deepEqual(curate.parse({ items: [{ url: 'a', title: 'A', kind: 'weird' }] }).items[0].kind, 'news');
  assert.deepEqual(curate.parse({ issue_date: 5, items: [{ url: 1 }] }), { items: [] }); // tolerante
  assert.deepEqual(curate.parse([1, 2]), { items: [] }); // raiz não-objeto: só os defaults (como o original)
  assert.equal(curate.parse({ issue_date: null }, { tolerant: false }), null); // estrito: items ausente
  const verify = legacy.buildVerifyRecordRequest({ url: 'u', content: 'c' });
  assert.deepEqual(verify.parse({ verdict: 'Maybe' }), { verdict: 'suspect', problems: [] });
  assert.deepEqual(verify.parse({ verdict: ' JUNK', problems: ['x'] }), { verdict: 'junk', problems: ['x'] });
  assert.equal(legacy.buildExtractLinksRequest('<a>').parse({ nope: 1 }), null);
  assert.deepEqual(legacy.buildExtractLinksRequest('<a>').parse({ links: [{ url: 'u', title: 't' }] }), [{ url: 'u', title: 't' }]);
  assert.equal(legacy.buildExtractArticleRequest('x').parse({ title: 't', content: 'c' }), null); // published_at nullable, não opcional
  const batch = legacy.buildRelevanceBatchRequest({ query: 'q', items: [] });
  assert.deepEqual(batch.parse({ results: [{ id: '7', relation: 'DIRECT', kind: 'lib' }] }), [{ id: 7, relation: 'direct', kind: 'news' }]);
  assert.equal(batch.parse({ results: [{ id: 1.5, relation: 'none', kind: 'news' }] }), null);
  assert.deepEqual(legacy.buildQuerySpecRequest('q').parse({ query_en: 'e' }), { must_have: [], nice_to_have: [], query_en: 'e', terms: [] });
  assert.equal(legacy.buildFacetRequest('domain', { title: 't', content: 'c' }, { taxonomy: MINI_TAX }).parse({ tags: [], uncovered: [] }), null);
  assert.deepEqual(legacy.buildDetectTypeRequest(FIXED_DETECT).parse({ type: 'INDEX' }), { type: 'listing', confidence: 0.5, reason: '' });
  assert.deepEqual(legacy.buildDetectTypeRequest(FIXED_DETECT).parse({ type: 'index', confidence: '0.9' }), { type: 'index', confidence: 0.9, reason: '' });
});

test('legacy: validação de tags congelada (alias → vocab → dedup → corte no máximo)', () => {
  const facets = legacy.getLegacyFacets(MINI_TAX);
  assert.deepEqual(facets.map((f) => f.name), legacy.FACET_ORDER);
  const topic = facets.find((f) => f.name === 'topic-technology');
  assert.deepEqual(topic.vocab, ['nodejs', 'performance', 'rust', 'rag']);
  assert.equal(facets.find((f) => f.name === 'domain').mandatory, true);
  assert.deepEqual(legacy.validateLegacyFacetTags('domain', ['Node', 'nodejs', 'go', 'rust'], MINI_TAX), { tags: ['nodejs', 'rust'], dropped: ['go'] });
  assert.deepEqual(legacy.validateLegacyFacetTags('nope', ['x'], MINI_TAX), { tags: [], dropped: [] });
  const p = legacy.buildFacetPrompt(facets[0], { title: 'T', content: 'abcdef' }, { taxonomy: MINI_TAX, maxChars: 3 });
  assert.ok(p.user.endsWith('Conteúdo:\nabc'));
  assert.ok(p.user.includes('node -> nodejs'));
});
