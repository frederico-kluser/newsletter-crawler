// Ledger por MOTOR (migração Jev, W1-C): seeds por motor (jev 0.0005 · gemini/flash 0.01 · resto
// 0.05), EMA pela chave do modelo PEDIDO (o Jev responde com o snapshot resolvido), byEngine/byModel/
// fallback no snapshot, 402 → CreditsExhaustedError (code BUDGET_EXCEEDED, trava sem --budget),
// sub-orçamento do fallback Gemini (FallbackBudgetExceededError, code próprio, NÃO trava a run), as
// colunas novas do llm_usage, estimateStageCallUsd filtrando pelo modelo e a guarda DEV_SPEND_GUARDED.
// Offline: o uso do Jev vem do DUBLÊ (makeJevTransport), sem rede; sandbox de env ANTES do import.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandboxEnv, withSandboxEnv } from './helpers/env.js';
import { makeJevTransport, JEV_DOUBLE_MODEL } from './helpers/jev-double.js';
import { GEMINI_DOUBLE_MODEL } from './helpers/gemini-double.js';

const sb = sandboxEnv({ JEV_ENABLED: 'false' }, { homePrefix: 'nc-budget-eng-' });
// Redundante com a sandbox (que já setou) — explícito p/ a malha do nc-home-isolation.test.js, que
// audita o assignment literal ANTES do 1º import de src/.
process.env.NC_HOME = sb.home;
const budget = await import('../src/budget.js');
const {
  BudgetLedger,
  BudgetExceededError,
  CreditsExhaustedError,
  FallbackBudgetExceededError,
  engineOf,
  seedForModel,
  resolveRunBudget,
  beginRun,
  endRun,
  reserve,
  shouldStop,
  creditsExhausted,
  getBudgetState,
  estimateStageCallUsd,
} = budget;
const { db, stmts } = await import('../src/db.js');
const { setLogSink } = await import('../src/util.js');

after(() => {
  db.close();
  sb.restore();
});

const JEV = 'typesafe/jev-1.13'; // o slug PEDIDO (o dublê responde com o resolvido, JEV_DOUBLE_MODEL)
const GEMINI = GEMINI_DOUBLE_MODEL;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/** Uma resposta REAL do dublê do Jev (formato da API): {model, usage:{input_tokens, output_tokens, cost}}. */
async function jevResponse(questions = { relevant: { type: 'noul', instructions: 'Is it relevant?', criteria: { true: 'yes', false: 'no' } } }) {
  const transport = makeJevTransport();
  const res = await transport({
    url: 'http://jev.test/api/alpha/decisions',
    headers: {},
    body: JSON.stringify({ model: JEV, state: { title: 'x' }, questions }),
    timeoutMs: 1000,
  });
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.body);
}

test('motor e seed por slug: jev 0.0005 · gemini/flash 0.01 · resto 0.05', () => {
  assert.equal(engineOf(JEV), 'jev');
  assert.equal(engineOf(JEV_DOUBLE_MODEL), 'jev');
  assert.equal(engineOf(GEMINI), 'chat');
  assert.equal(engineOf('deepseek/deepseek-v4-flash-0731'), 'chat');
  assert.equal(seedForModel(JEV), 0.0005);
  assert.equal(seedForModel(JEV_DOUBLE_MODEL), 0.0005);
  assert.equal(seedForModel(GEMINI), 0.01);
  assert.equal(seedForModel('deepseek/deepseek-v4-flash-0731'), 0.01);
  assert.equal(seedForModel('acme/llm-probe'), 0.05);
});

test('seed do Jev: 40 decisões em voo cabem num --budget de US$ 0,10 (o seed "pro" admitia 2)', () => {
  const l = new BudgetLedger({ budgetUsd: 0.1 });
  const tokens = [];
  for (let i = 0; i < 40; i++) tokens.push(l.reserve('verifyRecordJev', JEV)); // sem EMA: só o seed
  assert.equal(tokens.length, 40);
  assert.ok(near(l.reservedUsd, 40 * 0.0005));
  assert.equal(l.stopped, false);
  assert.equal(l.shouldStop(), false);
  tokens.forEach((t) => t.cancel());

  // contraste: com o seed "pro" (0.05, o que um slug do Jev reservava antes) só 2 cabem em voo
  const pro = new BudgetLedger({ budgetUsd: 0.1 });
  pro.reserve('x', 'acme/llm-probe');
  pro.reserve('x', 'acme/llm-probe');
  assert.throws(() => pro.reserve('x', 'acme/llm-probe'), BudgetExceededError);
});

test('shouldStop usa o MENOR seed: com US$ 0,0006 livres ainda cabe um Jev', () => {
  const l = new BudgetLedger({ budgetUsd: 0.01 });
  l.reserve('curate', 'deepseek/deepseek-v4-flash-0731').commit({ usage: { cost: 0.0094 } });
  assert.equal(l.shouldStop(), false, '0.0094 + 0.0005 <= 0.01');
  l.reserve('classifyJev', JEV).commit({ usage: { cost: 0.0002 } }); // seed do Jev ainda cabe
  assert.equal(l.shouldStop(), true, '0.0096 + 0.0005 > 0.01');
});

test('EMA pela chave do modelo PEDIDO, mesmo com o commit no snapshot resolvido', () => {
  const l = new BudgetLedger({ budgetUsd: 10 });
  assert.equal(l.estimate('classifyJev', JEV), 0.0005, 'seed antes de dados');
  for (let i = 0; i < 30; i++) {
    l.reserve('classifyJev', JEV).commit({ model: JEV_DOUBLE_MODEL, usage: { cost: 0.0001 } });
  }
  const est = l.estimate('classifyJev', JEV);
  assert.ok(est > 0.00015 && est < 0.00025, `2x EMA ~ 0.0002 no slug pedido (veio ${est})`);
  // requestedModel explícito vence o do reserve (ex.: reserva genérica, pedido concreto no commit)
  l.reserve('summarize', 'placeholder/model').commit({ model: GEMINI, requestedModel: GEMINI, usage: { cost: 0.002 } });
  assert.ok(near(l.estimate('summarize', GEMINI), 0.004), 'EMA gravado sob o requestedModel');
  assert.equal(l.estimate('summarize', 'placeholder/model'), 0.05, 'o placeholder ficou sem EMA');
});

test('commit: usage do Jev (input/output_tokens do dublê) → prompt/completion + engine/decisions/latência', async () => {
  const resp = await jevResponse({
    relevant: { type: 'noul', instructions: 'Is the record relevant?', criteria: { true: 'relevant', false: 'not relevant' } },
    junk: { type: 'noul', instructions: 'Is the record junk?', criteria: { true: 'junk', false: 'fine' } },
  });
  assert.equal(resp.model, JEV_DOUBLE_MODEL);
  const rows = [];
  const l = new BudgetLedger({ persist: (r) => rows.push(r) });
  l.reserve('verifyRecordJev', JEV).commit({
    model: resp.model,
    usage: resp.usage,
    engine: 'jev',
    decisions: 2,
    latencyMs: 412.6,
  });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.model, JEV_DOUBLE_MODEL, 'llm_usage.model = resolvido');
  assert.equal(r.requested_model, JEV, 'requested_model = pedido');
  assert.equal(r.prompt_tokens, resp.usage.input_tokens);
  assert.equal(r.completion_tokens, 0);
  assert.ok(near(r.cost_usd, resp.usage.cost));
  assert.equal(r.engine, 'jev');
  assert.equal(r.decisions, 2);
  assert.equal(r.fallback_reason, null);
  assert.equal(r.latency_ms, 413);
});

test('snapshot: byEngine/byModel globais e por estágio + fallback por motivo', () => {
  const l = new BudgetLedger();
  l.reserve('classifyJev', JEV).commit({ model: JEV_DOUBLE_MODEL, usage: { cost: 0.0003 }, engine: 'jev', decisions: 12 });
  l.reserve('classifyJev', JEV).commit({ model: JEV_DOUBLE_MODEL, usage: { cost: 0.0002 }, decisions: 8 }); // engine deduzido
  l.reserve('classify', GEMINI, { fallback: true }).commit({
    model: GEMINI,
    usage: { cost: 0.004, prompt_tokens: 3000, completion_tokens: 200 },
    engine: 'chat',
    decisions: 2,
    fallbackReason: 'low-confidence',
  });
  l.reserve('classify', GEMINI).commit({ model: GEMINI, usage: { cost: 0.003 }, fallbackReason: 'escape-option' });
  const snap = l.snapshot();
  assert.deepEqual(snap.byEngine.jev, { calls: 2, costUsd: 0.0005, decisions: 20 });
  assert.equal(snap.byEngine.chat.calls, 2);
  assert.ok(near(snap.byEngine.chat.costUsd, 0.007));
  assert.equal(snap.byModel[JEV_DOUBLE_MODEL].calls, 2, 'byModel pelo slug resolvido (o que foi cobrado)');
  assert.equal(snap.byModel[GEMINI].calls, 2);
  const cj = snap.byStage.classifyJev;
  assert.equal(cj.calls, 2);
  assert.equal(cj.decisions, 20);
  assert.equal(cj.byEngine.jev.calls, 2);
  assert.equal(cj.fallback.calls, 0);
  const c = snap.byStage.classify;
  assert.equal(c.fallback.calls, 2, 'reserve({fallback}) e commit({fallbackReason}) contam como fallback');
  assert.deepEqual(c.fallback.byReason, { 'low-confidence': 1, 'escape-option': 1 });
  assert.equal(snap.fallback.calls, 2);
  assert.ok(near(snap.fallback.spentUsd, 0.007));
  // cópia: mutar o snapshot não mexe nos contadores vivos
  snap.byStage.classify.calls = 999;
  snap.byEngine.jev.calls = 999;
  assert.equal(l.snapshot().byStage.classify.calls, 2);
  assert.equal(l.snapshot().byEngine.jev.calls, 2);
});

test('402: creditsExhausted trava SEM --budget; CreditsExhaustedError é um BudgetExceededError', () => {
  const l = new BudgetLedger();
  assert.equal(l.shouldStop(), false, 'ilimitado');
  l.reserve('verifyRecordJev', JEV).commit({ usage: { cost: 0.0002 } });
  l.creditsExhausted();
  l.creditsExhausted(); // idempotente
  assert.equal(l.shouldStop(), true);
  for (const opts of [undefined, { fallback: true }]) {
    assert.throws(() => l.reserve('verifyRecordJev', JEV, opts), (e) => {
      assert.ok(e instanceof CreditsExhaustedError);
      assert.ok(e instanceof BudgetExceededError, 'drivers tratam como parada graciosa');
      assert.equal(e.code, 'BUDGET_EXCEEDED');
      assert.equal(e.reason, 'credits');
      return true;
    });
  }
  assert.equal(l.snapshot().creditsOut, true);
});

test('sub-orçamento do fallback: o 1º cabe, o excedente lança FALLBACK_BUDGET_EXCEEDED sem travar a run', () => {
  const l = new BudgetLedger({ budgetUsd: 1, fallbackBudgetUsd: 0.015 });
  // 1º fallback: admitido (regra do 1º, como no orçamento da run)
  l.reserve('classify', GEMINI, { fallback: true }).commit({ model: GEMINI, usage: { cost: 0.008 }, fallbackReason: 'low-confidence' });
  // 0.008 gasto + est (2x EMA = 0.016) > 0.015 → nega
  assert.throws(() => l.reserve('classify', GEMINI, { fallback: true }), (e) => {
    assert.ok(e instanceof FallbackBudgetExceededError);
    assert.ok(!(e instanceof BudgetExceededError), 'NÃO pode parar a run');
    assert.equal(e.code, 'FALLBACK_BUDGET_EXCEEDED');
    assert.equal(e.reason, 'fallback-cap');
    assert.equal(e.capUsd, 0.015);
    return true;
  });
  assert.equal(l.stopped, false);
  assert.equal(l.shouldStop(), false);
  // chamadas primárias (Jev e chat não-fallback) seguem admitidas
  l.reserve('classifyJev', JEV).commit({ usage: { cost: 0.0002 } });
  l.reserve('summarize', GEMINI).commit({ usage: { cost: 0.003 } });
  assert.equal(l.snapshot().fallback.capUsd, 0.015);
});

test('fallback que não cabe no --budget da run: recusa sem _trip (o Jev barato ainda cabe)', () => {
  const l = new BudgetLedger({ budgetUsd: 0.02, fallbackBudgetUsd: 0 });
  // gasto num estágio chat primário (o EMA do verifyRecordJev segue no seed barato do Jev)
  l.reserve('curate', 'deepseek/deepseek-v4-flash-0731').commit({ usage: { cost: 0.0149 } });
  assert.throws(() => l.reserve('verifyRecord', GEMINI, { fallback: true }), (e) => {
    assert.equal(e.code, 'FALLBACK_BUDGET_EXCEEDED');
    assert.equal(e.reason, 'run-budget');
    return true;
  });
  assert.equal(l.stopped, false, 'o fallback recusado não trava o ledger');
  const t = l.reserve('verifyRecordJev', JEV); // 0.0149 + 0.0005 <= 0.02
  t.commit({ usage: { cost: 0.0003 } });
  // uma chamada chat PRIMÁRIA que não cabe trava como sempre
  assert.throws(() => l.reserve('summarize', GEMINI), (e) => e.code === 'BUDGET_EXCEEDED');
  assert.equal(l.stopped, true);
});

test('sub-teto default: GEMINI_FALLBACK_BUDGET_USD lida NA HORA; sem ela, 50% do --budget; sem nada, ilimitado', () => {
  const prev = process.env.GEMINI_FALLBACK_BUDGET_USD;
  try {
    delete process.env.GEMINI_FALLBACK_BUDGET_USD;
    assert.equal(new BudgetLedger().fallbackCapUsd(), 0, 'sem budget e sem env: ilimitado');
    const l = new BudgetLedger({ budgetUsd: 0.1 });
    assert.ok(near(l.fallbackCapUsd(), 0.05), '50% do --budget');
    process.env.GEMINI_FALLBACK_BUDGET_USD = '0.03';
    assert.equal(l.fallbackCapUsd(), 0.03, 'env lida na hora, sem recriar o ledger');
    assert.equal(new BudgetLedger().fallbackCapUsd(), 0.03, 'env vale também sem --budget');
    process.env.GEMINI_FALLBACK_BUDGET_USD = 'lixo';
    assert.ok(near(l.fallbackCapUsd(), 0.05), 'valor inválido cai na regra default');
    // sem sub-teto nem budget, o fallback nunca é recusado
    delete process.env.GEMINI_FALLBACK_BUDGET_USD;
    const free = new BudgetLedger();
    for (let i = 0; i < 20; i++) free.reserve('classify', GEMINI, { fallback: true }).commit({ usage: { cost: 0.01 } });
    assert.equal(free.snapshot().fallback.calls, 20);
  } finally {
    if (prev === undefined) delete process.env.GEMINI_FALLBACK_BUDGET_USD;
    else process.env.GEMINI_FALLBACK_BUDGET_USD = prev;
  }
});

test('cancel devolve a reserva do fallback também', () => {
  const l = new BudgetLedger({ budgetUsd: 1, fallbackBudgetUsd: 0.5 });
  const t = l.reserve('classify', GEMINI, { fallback: true });
  assert.ok(l.fallbackReservedUsd > 0);
  assert.ok(l.reservedUsd > 0);
  t.cancel();
  assert.equal(l.fallbackReservedUsd, 0);
  assert.equal(l.reservedUsd, 0);
});

test('resolveRunBudget: DEV_SPEND_GUARDED=1 faz de BUDGET_USD um TETO; fora da guarda, o pedido', () => {
  assert.equal(resolveRunBudget(0.5, {}), 0.5);
  assert.equal(resolveRunBudget(0, { BUDGET_USD: '0.04' }), 0, 'sem a guarda, BUDGET_USD não é lido aqui');
  const g = { DEV_SPEND_GUARDED: '1', BUDGET_USD: '0.04' };
  assert.equal(resolveRunBudget(0, g), 0.04, 'run "ilimitada" herda o teto');
  assert.equal(resolveRunBudget(0.5, g), 0.04, '--budget maior é limitado');
  assert.equal(resolveRunBudget(0.01, g), 0.01, '--budget menor vale');
  assert.equal(resolveRunBudget(0.5, { DEV_SPEND_GUARDED: '1' }), 0.5, 'guarda sem BUDGET_USD: o pedido');
});

test('singleton: colunas novas do llm_usage, estado por motor, status credits_exhausted e extrato', () => {
  const lines = [];
  setLogSink((e) => lines.push(e.text));
  try {
    const runId = beginRun({ command: 'crawl', budgetUsd: 0 });
    reserve('verifyRecordJev', JEV).commit({
      model: JEV_DOUBLE_MODEL,
      usage: { input_tokens: 6200, output_tokens: 0, cost: 0.00026 },
      engine: 'jev',
      decisions: 8,
      latencyMs: 480,
    });
    reserve('verifyRecord', GEMINI, { fallback: true }).commit({
      model: GEMINI,
      usage: { prompt_tokens: 2500, completion_tokens: 150, cost: 0.0025 },
      decisions: 1,
      fallbackReason: 'low-confidence',
      latencyMs: 2100,
    });
    const st = getBudgetState();
    assert.equal(st.runId, runId);
    assert.equal(st.byEngine.jev.decisions, 8);
    assert.equal(st.byEngine.chat.calls, 1);
    assert.equal(st.fallback.calls, 1);
    assert.equal(st.byStage.verifyRecord.fallback.byReason['low-confidence'], 1);

    const rows = db.prepare('SELECT * FROM llm_usage WHERE run_id = ? ORDER BY id').all(runId);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].engine, 'jev');
    assert.equal(rows[0].model, JEV_DOUBLE_MODEL);
    assert.equal(rows[0].requested_model, JEV);
    assert.equal(rows[0].decisions, 8);
    assert.equal(rows[0].prompt_tokens, 6200);
    assert.equal(rows[0].latency_ms, 480);
    assert.equal(rows[0].fallback_reason, null);
    assert.equal(rows[1].engine, 'chat');
    assert.equal(rows[1].fallback_reason, 'low-confidence');

    const byEng = stmts.usageByStageEngine.all(runId);
    const jevRow = byEng.find((r) => r.engine === 'jev');
    assert.equal(jevRow.stage, 'verifyRecordJev');
    assert.equal(jevRow.decisions, 8);
    const chatRow = byEng.find((r) => r.engine === 'chat');
    assert.equal(chatRow.fallback_calls, 1);
    assert.ok(near(chatRow.fallback_usd, 0.0025));

    creditsExhausted(); // 402 visto no meio da run
    assert.equal(shouldStop(), true, 'para mesmo sem --budget');
    assert.throws(() => reserve('verifyRecordJev', JEV), CreditsExhaustedError);
    endRun();
    assert.equal(stmts.getRunById.get(runId).status, 'credits_exhausted');
    const extrato = lines.join('\n');
    assert.match(extrato, /extrato do run #\d+ \(crawl\): 2 chamadas/);
    assert.match(extrato, /motores: jev 1x · 8 decisões · US\$ 0\.0003 \| chat 1x · 1 decisões · US\$ 0\.0025 \(fallback 1x/);
    assert.match(extrato, /verifyRecordJev: 1x — US\$ 0\.0003 \(jev · 8 dec\)/);
    assert.match(extrato, /verifyRecord: 1x — US\$ 0\.0025 \(1 dec · fallback 1x: low-confidence 1\)/);
    // fora de uma run: ledger default ilimitado e sem o 402 da run anterior
    assert.equal(shouldStop(), false);
  } finally {
    setLogSink(null);
  }
});

test('beginRun reseta o placar de decisões do Jev (decision-stats é por run)', async () => {
  const ds = await import('../src/decision-stats.js');
  ds.record('classifyJev', [{ outcome: 'accept' }, { outcome: 'fallback', reason: 'low-confidence' }]);
  assert.equal(ds.snapshot().totals.decisions, 2);
  beginRun({ command: 'finish' });
  assert.equal(ds.snapshot().totals.decisions, 0);
  endRun();
});

test('estimateStageCallUsd(stage, model) filtra pelo modelo pedido; sem amostra cai no seed DO modelo', () => {
  beginRun({ command: 'estimate-fixture' });
  for (let i = 0; i < 3; i++) {
    reserve('curate', 'deepseek/deepseek-v4-flash-0731').commit({ usage: { cost: 0.0003 } });
    reserve('curate', GEMINI).commit({ model: `${GEMINI}-20260801`, usage: { cost: 0.004 } });
  }
  endRun();
  assert.ok(near(estimateStageCallUsd('curate', 'deepseek/deepseek-v4-flash-0731'), 0.0003));
  assert.ok(near(estimateStageCallUsd('curate', GEMINI), 0.004), 'casa pelo requested_model mesmo com o resolvido diferente');
  assert.ok(near(estimateStageCallUsd('curate'), (0.0003 + 0.004) / 2), 'sem modelo: média do estágio');
  assert.equal(estimateStageCallUsd('curate', JEV), 0.0005, 'modelo sem histórico: seed dele');
  assert.equal(estimateStageCallUsd('nunca-rodou', 'acme/pro'), 0.05);
});

test('DEV_SPEND_GUARDED=1: o ledger DEFAULT (sem beginRun) respeita BUDGET_USD; beginRun limita o --budget', async () => {
  const budgetUrl = new URL('../src/budget.js', import.meta.url).href;
  const script = `
    const b = await import(${JSON.stringify(budgetUrl)});
    const out = {};
    b.reserve('evalJev', 'acme/llm-probe').commit({ usage: { cost: 0.0009 } });
    try { b.reserve('evalJev', 'acme/llm-probe'); out.second = 'admitida'; } catch (e) { out.second = e.code; }
    out.stop = b.shouldStop();
    out.defaultBudget = b.getBudgetState().budgetUsd;
    b.beginRun({ command: 'crawl', budgetUsd: 0.5 });
    out.runBudget = b.getBudgetState().budgetUsd;
    b.endRun();
    console.log('RESULT:' + JSON.stringify(out));
  `;
  const run = (overrides) =>
    withSandboxEnv(overrides, () => {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT; // o filho não é um arquivo de teste
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env,
        encoding: 'utf8',
        timeout: 30000,
      });
      const line = String(r.stdout).split('\n').find((l) => l.startsWith('RESULT:'));
      assert.ok(line, `filho sem RESULT (status ${r.status}): ${r.stderr}`);
      return JSON.parse(line.slice('RESULT:'.length));
    }, { homePrefix: 'nc-budget-guard-' });

  const guarded = await run({ DEV_SPEND_GUARDED: '1', BUDGET_USD: '0.001' });
  assert.equal(guarded.defaultBudget, 0.001);
  assert.equal(guarded.second, 'BUDGET_EXCEEDED', 'fora de beginRun, a 2ª chamada estoura o teto do dev-spend');
  assert.equal(guarded.stop, true);
  assert.equal(guarded.runBudget, 0.001, '--budget 0.5 limitado ao que resta da guarda');

  const free = await run({ BUDGET_USD: '0.001' });
  assert.equal(free.defaultBudget, 0, 'sem a guarda, o default segue ilimitado');
  assert.equal(free.second, 'admitida');
  assert.equal(free.stop, false);
  assert.equal(free.runBudget, 0.5);
});
