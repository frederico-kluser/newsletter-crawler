// Eval do ledger de orçamento: admissão por reserva, regra da 1ª chamada, EMA da estimativa,
// cancel devolve a reserva, latch do stop, e o singleton persistindo em runs/llm_usage.
// Usa NC_HOME TEMPORÁRIO (setado ANTES do import dinâmico) — nunca toca o banco real.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-budget-'));
const { BudgetLedger, BudgetExceededError, beginRun, endRun, reserve, getBudgetState, shouldStop } =
  await import('../src/budget.js');
const { db, stmts } = await import('../src/db.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

const flashUsage = (cost) => ({ cost, prompt_tokens: 1000, completion_tokens: 200 });

test('ilimitado (budget 0): nunca bloqueia, mas registra tudo', () => {
  const rows = [];
  const l = new BudgetLedger({ budgetUsd: 0, persist: (r) => rows.push(r) });
  for (let i = 0; i < 5; i++) {
    const t = l.reserve('summarize', 'deepseek/deepseek-v4-flash');
    t.commit({ usage: flashUsage(0.001) });
  }
  assert.equal(l.shouldStop(), false);
  assert.equal(l.calls, 5);
  assert.ok(Math.abs(l.spentUsd - 0.005) < 1e-9);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].cost_usd, 0.001);
});

test('bloqueia quando spent + reservado + estimativa > budget; latch + code', () => {
  const l = new BudgetLedger({ budgetUsd: 0.02 });
  const t1 = l.reserve('classify', 'deepseek/deepseek-v4-pro'); // 1ª chamada: sempre admite
  t1.commit({ usage: flashUsage(0.015) });
  // sobra 0.005 < seed pro (0.05) -> nega e trava
  assert.throws(() => l.reserve('classify', 'deepseek/deepseek-v4-pro'), (e) => {
    assert.ok(e instanceof BudgetExceededError);
    assert.equal(e.code, 'BUDGET_EXCEEDED');
    return true;
  });
  assert.equal(l.stopped, true, 'negação trava o ledger');
  assert.throws(() => l.reserve('summarize', 'deepseek/deepseek-v4-flash'), BudgetExceededError);
  assert.equal(l.shouldStop(), true);
});

test('regra da 1ª chamada: budget menor que o seed ainda admite 1 chamada', () => {
  const l = new BudgetLedger({ budgetUsd: 0.001 });
  const t = l.reserve('classify', 'deepseek/deepseek-v4-pro'); // seed 0.05 > 0.001, mas é a 1ª
  t.commit({ usage: flashUsage(0.0008) });
  assert.equal(l.calls, 1);
  assert.equal(l.shouldStop(), true, 'depois da 1ª, a sobra não paga nem uma Flash');
});

test('estimativa: seed antes de dados; converge p/ 2x EMA com clamp', () => {
  const l = new BudgetLedger({ budgetUsd: 10 });
  assert.equal(l.estimate('summarize', 'deepseek/deepseek-v4-flash'), 0.005, 'seed flash');
  assert.equal(l.estimate('classify', 'deepseek/deepseek-v4-pro'), 0.05, 'seed pro');
  for (let i = 0; i < 30; i++) {
    l.reserve('summarize', 'deepseek/deepseek-v4-flash').commit({ usage: flashUsage(0.002) });
  }
  const est = l.estimate('summarize', 'deepseek/deepseek-v4-flash');
  assert.ok(est > 0.0035 && est < 0.0045, `2x EMA ~ 0.004 (veio ${est})`);
  // clamp inferior: custos ~0 não derrubam a reserva abaixo de seed/10
  for (let i = 0; i < 50; i++) {
    l.reserve('summarize', 'deepseek/deepseek-v4-flash').commit({ usage: flashUsage(0) });
  }
  assert.equal(l.estimate('summarize', 'deepseek/deepseek-v4-flash'), 0.0005, 'piso seed/10');
});

test('cancel devolve a reserva (e o token é de uso único)', () => {
  const l = new BudgetLedger({ budgetUsd: 1 });
  const t = l.reserve('classify', 'deepseek/deepseek-v4-pro');
  assert.ok(l.reservedUsd > 0);
  t.cancel();
  assert.equal(l.reservedUsd, 0);
  t.commit({ usage: flashUsage(9) }); // uso único: commit após cancel é no-op
  assert.equal(l.spentUsd, 0);
  assert.equal(l.calls, 0);
});

test('singleton: beginRun/endRun persistem runs + llm_usage no NC_HOME temporário', () => {
  const runId = beginRun({ command: 'crawl', budgetUsd: 0.5, args: { 'max-articles': 3 } });
  assert.ok(Number.isInteger(runId));
  assert.equal(shouldStop(), false);
  reserve('summarize', 'deepseek/deepseek-v4-flash').commit({ usage: flashUsage(0.0012) });
  reserve('classify', 'deepseek/deepseek-v4-pro').commit({ usage: flashUsage(0.02) });
  const state = getBudgetState();
  assert.equal(state.runId, runId);
  assert.equal(state.calls, 2);
  assert.ok(Math.abs(state.spentUsd - 0.0212) < 1e-9);
  assert.equal(state.byStage.summarize.calls, 1);
  endRun();
  const run = stmts.getLastRun.get();
  assert.equal(run.id, runId);
  assert.equal(run.status, 'done');
  assert.ok(Math.abs(run.spent_usd - 0.0212) < 1e-9);
  const usage = stmts.sumUsageForRun.get(runId);
  assert.equal(usage.n, 2);
});
