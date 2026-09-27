// Log central das decisões do Jev (W1-C): events.logDecision enfileira no MESMO buffer dos events e
// grava na MESMA transação do flush (tabela jev_decisions). JEV_TRACE (lido na hora): min (default)
// = todo desfecho não-aceito + amostra DETERMINÍSTICA de 5% dos aceitos (hash de subject+qid, sem
// Math.random); full = tudo; off = nada. Linha inválida é descartada ANTES do flush (um CHECK falhando
// levaria junto os events do lote). Mais: as statements de leitura (inspect/export), a migração
// idempotente das colunas novas do llm_usage num banco ANTIGO, e o wipeAll/hasAnyData com a tabela.
// Sandbox de env (NC_HOME tmp + DB_PATH neutralizado) ANTES do import — nunca toca o banco real.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { sandboxEnv, NEUTRALIZED_KEYS } from './helpers/env.js';

const sb = sandboxEnv({ EVENTS_FLUSH_AT: '10' }, { homePrefix: 'nc-events-dec-' });
// Redundante com a sandbox (que já setou) — explícito p/ a malha do nc-home-isolation.test.js, que
// audita o assignment literal ANTES do 1º import de src/.
process.env.NC_HOME = sb.home;
const { logEvent, logDecision, flushEvents, traceBucket, decisionSampleRate, traceMode, DECISION_OUTCOMES } =
  await import('../src/events.js');
const { db, stmts, wipeAll } = await import('../src/db.js');

after(() => {
  db.close();
  sb.restore();
});

const count = (t, where = '1=1') => db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${where}`).get().c;
const setTrace = (v) => {
  if (v == null) delete process.env.JEV_TRACE;
  else process.env.JEV_TRACE = v;
};

beforeEach(() => {
  flushEvents();
  db.exec('DELETE FROM jev_decisions; DELETE FROM events;');
  setTrace(null);
  delete process.env.JEV_TRACE_SAMPLE;
});

test('schema: jev_decisions com CHECK do desfecho + colunas novas do llm_usage', () => {
  const cols = db.prepare('PRAGMA table_info(jev_decisions)').all().map((c) => c.name);
  for (const c of ['run_id', 'stage', 'subject', 'url', 'qid', 'value', 'p', 'certainty', 'threshold',
    'outcome', 'reason', 'fb_value', 'agree', 'model', 'sample_rate', 'created_at']) {
    assert.ok(cols.includes(c), `jev_decisions.${c}`);
  }
  const idx = db.prepare("SELECT name FROM pragma_index_list('jev_decisions')").all().map((r) => r.name);
  assert.ok(idx.includes('idx_jev_decisions_run_stage'));
  assert.ok(idx.includes('idx_jev_decisions_stage_qid'));
  assert.throws(
    () => db.prepare("INSERT INTO jev_decisions (stage, qid, outcome) VALUES ('s', 'q', 'bogus')").run(),
    /CHECK constraint/,
  );
  const usage = db.prepare('PRAGMA table_info(llm_usage)').all().map((c) => c.name);
  for (const c of ['engine', 'decisions', 'fallback_reason', 'latency_ms', 'requested_model']) {
    assert.ok(usage.includes(c), `llm_usage.${c}`);
  }
  assert.deepEqual([...DECISION_OUTCOMES], ['accept', 'fallback', 'default', 'error', 'shadow']);
});

test('logDecision NÃO grava na hora; o flush grava events + decisões na MESMA chamada', () => {
  setTrace('full');
  logEvent({ runId: 7, url: 'https://a.test/x', stage: 'verify', status: 'ok' });
  const n = logDecision(
    [
      { qid: 'junk', value: false, p: 0.08, certainty: 0.84, threshold: 0.7, outcome: 'accept' },
      { qid: 'kind', value: 'tool', certainty: 0.41, threshold: 0.7, outcome: 'fallback', reason: 'low-confidence', fbValue: 'news', agree: false },
    ],
    { runId: 7, url: 'https://a.test/x', stage: 'verifyRecordJev', subject: 'art:1', model: 'typesafe/jev-1.13-20260917' },
  );
  assert.equal(n, 2);
  assert.equal(count('jev_decisions'), 0, 'ainda no buffer');
  assert.equal(count('events'), 0);
  assert.equal(flushEvents(), 3, 'flush devolve events + decisões');
  assert.equal(count('events'), 1);
  const rows = stmts.listJevDecisions.all({ runId: 7, stage: null, qid: null, outcome: null, lim: -1 });
  assert.equal(rows.length, 2);
  const [a, f] = rows;
  assert.equal(a.stage, 'verifyRecordJev');
  assert.equal(a.subject, 'art:1');
  assert.equal(a.url, 'https://a.test/x');
  assert.equal(a.value, 'false', 'noul booleano vira JSON');
  assert.equal(a.p, 0.08);
  assert.equal(a.model, 'typesafe/jev-1.13-20260917');
  assert.equal(a.sample_rate, 1);
  assert.equal(f.value, 'tool', 'opção de choice fica crua (legível no SQL)');
  assert.equal(f.fb_value, 'news');
  assert.equal(f.agree, 0);
  assert.equal(f.reason, 'low-confidence');
  assert.equal(f.p, null, 'p ausente → NULL');
});

test('auto-flush pelo total do buffer (events + decisões) ≥ EVENTS_FLUSH_AT', () => {
  setTrace('full');
  for (let i = 0; i < 6; i++) logEvent({ runId: 8, stage: 'fetch', status: 'ok' });
  assert.equal(count('events'), 0);
  logDecision(
    Array.from({ length: 4 }, (_, i) => ({ qid: `q${i}`, outcome: 'accept', value: true })),
    { runId: 8, stage: 'classifyJev', subject: 'art:2' },
  ); // 6 + 4 = 10 → flush
  assert.equal(count('events'), 6);
  assert.equal(count('jev_decisions'), 4);
});

test('JEV_TRACE=min (default): todo não-aceito + amostra determinística de ~5% dos aceitos', () => {
  assert.equal(traceMode(), 'min');
  const rows = [];
  for (let i = 0; i < 2000; i++) rows.push({ subject: `art:${i}`, qid: 'relevant', outcome: 'accept', value: true });
  for (let i = 0; i < 30; i++) {
    rows.push({ subject: `art:${i}`, qid: 'kind', outcome: DECISION_OUTCOMES[1 + (i % 4)], reason: 'low-confidence' });
  }
  const kept = logDecision(rows, { runId: 9, stage: 'classifyJev' });
  flushEvents();
  const accepted = count('jev_decisions', "outcome = 'accept'");
  assert.equal(count('jev_decisions', "outcome <> 'accept'"), 30, 'nenhum não-aceito é amostrado fora');
  assert.ok(accepted > 60 && accepted < 140, `~5% de 2000 aceitos (veio ${accepted})`);
  assert.equal(kept, accepted + 30);
  // determinística: é exatamente quem cai abaixo de 0.05 no bucket do (subject, qid)
  const expected = rows.filter((r) => r.outcome === 'accept' && traceBucket(r.subject, r.qid) < 0.05).length;
  assert.equal(accepted, expected);
  const rates = db.prepare("SELECT DISTINCT sample_rate r FROM jev_decisions WHERE outcome = 'accept'").all();
  assert.deepEqual(rates.map((r) => r.r), [0.05], 'aceito amostrado carrega a taxa (p/ estimar o total)');
  // o total ESTIMADO volta à ordem de grandeza real
  const agg = stmts.countJevDecisionsByStageOutcome.all(9).find((r) => r.outcome === 'accept');
  assert.equal(agg.n, accepted);
  assert.equal(agg.est, accepted * 20);
  // mesma decisão, mesmo lado da amostra (sem Math.random)
  const r0 = { subject: 'art:1', qid: 'relevant', outcome: 'accept' };
  const first = decisionSampleRate(r0, { mode: 'min', rate: 0.05 });
  for (let k = 0; k < 5; k++) assert.equal(decisionSampleRate(r0, { mode: 'min', rate: 0.05 }), first);
});

test('JEV_TRACE_SAMPLE ajusta a taxa (lida na hora); 0 desliga a amostra dos aceitos', () => {
  process.env.JEV_TRACE_SAMPLE = '0';
  const rows = Array.from({ length: 200 }, (_, i) => ({ subject: `s${i}`, qid: 'q', outcome: 'accept' }));
  assert.equal(logDecision(rows, { stage: 'x' }), 0);
  process.env.JEV_TRACE_SAMPLE = '1';
  assert.equal(logDecision(rows, { stage: 'x' }), 200);
  flushEvents();
});

test('JEV_TRACE=full grava tudo; off não grava nada (nem os não-aceitos)', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ subject: `s${i}`, qid: 'q', outcome: i % 3 ? 'accept' : 'fallback' }));
  setTrace('full');
  assert.equal(logDecision(rows, { stage: 'x', runId: 10 }), 12);
  setTrace('off');
  assert.equal(logDecision(rows, { stage: 'x', runId: 10 }), 0);
  setTrace('LIXO');
  assert.equal(traceMode(), 'min', 'valor desconhecido cai no default');
  flushEvents();
  assert.equal(count('jev_decisions', 'run_id = 10'), 12);
});

test('linha inválida é descartada ANTES do flush e não derruba os events do lote; nunca lança', () => {
  setTrace('full');
  logEvent({ runId: 11, stage: 'save', status: 'ok' });
  const circular = {};
  circular.self = circular;
  const kept = logDecision(
    [
      { qid: 'q1', outcome: 'maybe' }, // desfecho fora do CHECK
      { outcome: 'accept' }, // sem qid
      null,
      'lixo',
      { qid: 'q2', outcome: 'ACCEPT', value: circular, p: 'NaN', certainty: Infinity, agree: 'talvez' },
    ],
    { runId: 11, stage: 'verifyRecordJev' },
  );
  assert.equal(kept, 1);
  assert.equal(logDecision([{ qid: 'q3', outcome: 'accept' }]), 0, 'sem stage: descartada');
  assert.equal(logDecision(undefined), 0);
  assert.doesNotThrow(() => logDecision({ qid: 'q4', outcome: 'error', stage: 's' }), 'linha única (não-array)');
  assert.equal(flushEvents(), 3);
  assert.equal(count('events', 'run_id = 11'), 1, 'o event do lote foi gravado');
  const r = db.prepare("SELECT * FROM jev_decisions WHERE qid = 'q2'").get();
  assert.equal(r.outcome, 'accept', 'desfecho normalizado p/ minúsculas');
  assert.equal(r.value, '[object Object]', 'valor circular vira rótulo, não derruba');
  assert.equal(r.p, null);
  assert.equal(r.certainty, null);
  assert.equal(r.agree, null);
});

test('statements de leitura: filtros anuláveis, motivos e os fallbacks de menor certeza', () => {
  setTrace('full');
  logDecision(
    [
      { subject: 'a', qid: 'kind', outcome: 'fallback', reason: 'low-confidence', certainty: 0.4 },
      { subject: 'b', qid: 'kind', outcome: 'fallback', reason: 'low-confidence', certainty: 0.2 },
      { subject: 'c', qid: 'kind', outcome: 'fallback', reason: 'escape-option', certainty: 0.9 },
      { subject: 'd', qid: 'junk', outcome: 'default', reason: 'fallback-budget' },
      { subject: 'e', qid: 'junk', outcome: 'accept', certainty: 0.95 },
    ],
    { runId: 12, stage: 'verifyRecordJev' },
  );
  logDecision([{ subject: 'z', qid: 'rel', outcome: 'accept' }], { runId: 12, stage: 'searchBatchJev' });
  flushEvents();
  assert.equal(stmts.listJevDecisions.all({ runId: 12, stage: 'verifyRecordJev', qid: null, outcome: null, lim: -1 }).length, 5);
  assert.equal(stmts.listJevDecisions.all({ runId: 12, stage: null, qid: 'kind', outcome: 'fallback', lim: -1 }).length, 3);
  assert.equal(stmts.listJevDecisions.all({ runId: null, stage: 'searchBatchJev', qid: null, outcome: null, lim: 10 }).length, 1);
  const byOutcome = stmts.countJevDecisionsByStageOutcome.all(12);
  const fb = byOutcome.find((r) => r.stage === 'verifyRecordJev' && r.outcome === 'fallback');
  assert.equal(fb.n, 3);
  assert.equal(fb.est, 3);
  assert.ok(Math.abs(fb.avg_certainty - 0.5) < 1e-9);
  const reasons = stmts.countJevDecisionReasonsForRun.all(12);
  assert.deepEqual(reasons[0], { stage: 'verifyRecordJev', outcome: 'fallback', reason: 'low-confidence', n: 2 });
  assert.ok(!reasons.some((r) => r.outcome === 'accept'), 'só não-aceitos');
  const low = stmts.listJevLowestCertaintyForRun.all({ runId: 12, lim: 3 });
  assert.deepEqual(low.map((r) => r.subject), ['b', 'a', 'c'], 'menor certeza primeiro, NULL por último');
});

test('usageByStageEngine/sumUsageByEngine: linha sem engine é deduzida pelo slug (typesafe/* = jev)', () => {
  const runId = stmts.insertRun.get({ command: 'fixture', args: null, budget_usd: null }).id; // FK llm_usage→runs
  const ins = (row) =>
    stmts.insertLlmUsage.run({
      run_id: runId, prompt_tokens: null, completion_tokens: null, engine: null, decisions: null,
      fallback_reason: null, latency_ms: null, requested_model: null, ...row,
    });
  ins({ stage: 'classifyJev', model: 'typesafe/jev-1.13-20260917', cost_usd: 0.0002 });
  ins({ stage: 'classify', model: 'deepseek/deepseek-v4-flash-0731', cost_usd: 0.0003 });
  ins({ stage: 'classify', model: 'google/gemini-3.8-flash', cost_usd: 0.004, engine: 'chat', decisions: 2, fallback_reason: 'low-confidence', latency_ms: 900 });
  const rows = stmts.usageByStageEngine.all(runId);
  const jev = rows.find((r) => r.stage === 'classifyJev');
  assert.equal(jev.engine, 'jev');
  const chat = rows.find((r) => r.stage === 'classify');
  assert.equal(chat.engine, 'chat');
  assert.equal(chat.n, 2);
  assert.equal(chat.decisions, 2);
  assert.equal(chat.fallback_calls, 1);
  assert.ok(Math.abs(chat.fallback_usd - 0.004) < 1e-12);
  assert.equal(chat.max_latency_ms, 900);
  const all = Object.fromEntries(stmts.sumUsageByEngine.all().map((r) => [r.engine, r.n]));
  assert.ok(all.jev >= 1 && all.chat >= 2);
});

test('hasAnyData enxerga jev_decisions; wipeAll a esvazia', () => {
  setTrace('full');
  logDecision([{ qid: 'q', outcome: 'fallback' }], { stage: 's' });
  flushEvents();
  assert.equal(stmts.hasAnyData.get().x, 1);
  wipeAll();
  assert.equal(count('jev_decisions'), 0);
  assert.equal(count('events'), 0);
});

test('migração idempotente: banco ANTIGO (llm_usage sem as colunas novas) ganha tudo, 2x sem erro', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-events-mig-'));
  try {
    const file = path.join(dir, 'old.db');
    const old = new Database(file);
    old.exec(`CREATE TABLE llm_usage (id INTEGER PRIMARY KEY, run_id INTEGER, stage TEXT, model TEXT,
                prompt_tokens INTEGER, completion_tokens INTEGER, cost_usd REAL,
                created_at TEXT DEFAULT (datetime('now')));
              INSERT INTO llm_usage (stage, model, cost_usd) VALUES ('classify', 'deepseek/deepseek-v4-flash-0731', 0.0003);`);
    old.close();
    const dbUrl = new URL('../src/db.js', import.meta.url).href;
    const script = `
      const { db } = await import(${JSON.stringify(dbUrl)});
      const cols = db.prepare('PRAGMA table_info(llm_usage)').all().map((c) => c.name);
      const t = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'jev_decisions'").get().c;
      const kept = db.prepare('SELECT COUNT(*) c FROM llm_usage').get().c;
      db.close();
      console.log('RESULT:' + JSON.stringify({ cols, t, kept }));
    `;
    // NC_HOME PRÓPRIO do filho com um .env que aponta o DB_PATH p/ o banco antigo: o NC_HOME/.env é
    // o último da precedência (vence o .env do repo e o semeado pela sandbox, que zera DB_PATH).
    writeFileSync(path.join(dir, '.env'), `${NEUTRALIZED_KEYS.filter((k) => k !== 'DB_PATH').map((k) => `${k}=`).join('\n')}\nDB_PATH=${file}\n`);
    const runChild = () => {
      const env = { ...process.env, NC_HOME: dir, DB_PATH: file };
      delete env.NODE_TEST_CONTEXT;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env,
        encoding: 'utf8',
        timeout: 30000,
      });
      const line = String(r.stdout).split('\n').find((l) => l.startsWith('RESULT:'));
      assert.ok(line, `filho sem RESULT (status ${r.status}): ${r.stderr}`);
      return JSON.parse(line.slice('RESULT:'.length));
    };
    for (let i = 0; i < 2; i++) {
      const out = runChild();
      for (const c of ['engine', 'decisions', 'fallback_reason', 'latency_ms', 'requested_model']) {
        assert.ok(out.cols.includes(c), `rodada ${i + 1}: llm_usage.${c}`);
      }
      assert.equal(out.t, 1, 'jev_decisions criada');
      assert.equal(out.kept, 1, 'linha antiga preservada');
    }
    // a linha antiga continua sem engine/requested_model (sem backfill: quem lê deduz pelo slug)
    const back = new Database(file, { readonly: true });
    const row = back.prepare('SELECT engine, requested_model FROM llm_usage').get();
    back.close();
    assert.equal(row.engine, null);
    assert.equal(row.requested_model, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
