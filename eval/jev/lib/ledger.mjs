// Ledger ISOLADO do eval: todo processo filho do eval grava o llm_usage (e runs/events) em
// eval/jev/.ledger.db, NUNCA no crawler.db do usuário. Os planos antigos de eval rodavam sob
// runWithLimits no banco real e sujavam o extrato de custo da ferramenta; aqui o custo do eval
// fica num arquivo próprio (ignorado no git) e é resumido por este módulo.
//
// Dois cuidados, porque o src/config.js carrega o NC_HOME/.env COM override (o .env vence o env
// do processo) e o eval não pode ler aquele arquivo:
// 1. ledgerEnv() monta o env do filho com DB_PATH ABSOLUTO (config.js resolve relativo contra o
//    NC_HOME) e LLM_PROVIDER=openrouter (gap #11 do crítico: um LLM_PROVIDER=deepseek no .env
//    mandaria o baseline p/ api.deepseek.com com o slug traduzido).
// 2. Mesmo assim um DB_PATH/LLM_PROVIDER no NC_HOME/.env venceria. Por isso o runner, DENTRO do
//    filho e ANTES de qualquer chamada paga, passa os valores RESOLVIDOS por config.js para
//    assertLedgerIsolation() — que recusa rodar se o banco não for o ledger.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export const LEDGER_DB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.ledger.db');

/** Env do processo filho do eval: DB_PATH → ledger, provedor OpenRouter. Não muta `base`. */
export function ledgerEnv(base = process.env, { ledgerPath = LEDGER_DB, extra = {} } = {}) {
  return { ...base, DB_PATH: path.resolve(ledgerPath), LLM_PROVIDER: 'openrouter', ...extra };
}

/**
 * Guarda de isolamento (chamada no filho, com os valores que config.js RESOLVEU). Lança se o
 * banco ativo não é o ledger ou se o provedor não é OpenRouter — melhor abortar um eval do que
 * gravar custo no acervo do usuário ou mandar o baseline ao provedor errado.
 */
export function assertLedgerIsolation({ dbPath, provider = 'openrouter' }, { ledgerPath = LEDGER_DB } = {}) {
  if (!dbPath || path.resolve(dbPath) !== path.resolve(ledgerPath)) {
    throw new Error(
      `eval: DB_PATH resolvido (${dbPath}) não é o ledger isolado (${ledgerPath}). ` +
        'Um DB_PATH no NC_HOME/.env venceu o env do filho — rode o eval com o ledger ou remova o override.',
    );
  }
  if (provider !== 'openrouter') {
    throw new Error(`eval: LLM_PROVIDER resolvido é '${provider}', esperado 'openrouter' (o NC_HOME/.env venceu o env do filho).`);
  }
  return true;
}

// ---- resumo do llm_usage (somente-leitura) ----
// Colunas OPCIONAIS entram só se existirem (engine/decisions/fallback_reason/latency_ms chegam na
// W1; um ledger criado antes delas continua legível). Lista fechada = nada de SQL montado com
// texto externo.
const OPTIONAL_COLUMNS = ['engine', 'decisions', 'fallback_reason', 'latency_ms'];
const Q = {
  columns: 'PRAGMA table_info(llm_usage)',
  hasTable: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  runs: 'SELECT id, command, args, budget_usd, status, started_at, finished_at FROM runs ORDER BY id',
  usage: (cols) =>
    `SELECT id, run_id, stage, model, prompt_tokens, completion_tokens, cost_usd, created_at${cols.map((c) => `, ${c}`).join('')} ` +
    'FROM llm_usage ORDER BY id',
};

const round6 = (x) => Math.round(x * 1e6) / 1e6;

function emptyBucket() {
  return { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, decisions: 0, latencyMsSum: 0, latencyN: 0 };
}

function addRow(bucket, r) {
  bucket.calls++;
  bucket.promptTokens += r.prompt_tokens || 0;
  bucket.completionTokens += r.completion_tokens || 0;
  bucket.costUsd += r.cost_usd || 0;
  bucket.decisions += r.decisions || 0;
  if (Number.isFinite(r.latency_ms)) {
    bucket.latencyMsSum += r.latency_ms;
    bucket.latencyN++;
  }
}

function finishBucket(b) {
  return {
    calls: b.calls,
    promptTokens: b.promptTokens,
    completionTokens: b.completionTokens,
    costUsd: round6(b.costUsd),
    decisions: b.decisions,
    avgLatencyMs: b.latencyN ? Math.round(b.latencyMsSum / b.latencyN) : null,
  };
}

/**
 * Instante UTC (ms) de um carimbo: o `created_at` do SQLite (`datetime('now')` = 'YYYY-MM-DD HH:MM:SS',
 * UTC, com ESPAÇO) ou um ISO ('…T…Z', com ou sem fração/fuso; só a data = meia-noite UTC). Sem fuso
 * explícito vale UTC — o do SQLite. Ilegível → NaN.
 */
export function utcMs(stamp) {
  let t = String(stamp ?? '').trim();
  if (!t) return Number.NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return Date.parse(`${t}T00:00:00Z`);
  t = t.replace(' ', 'T');
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(t)) t += 'Z';
  return Date.parse(t);
}

/**
 * Agrega linhas do llm_usage (puro — testável sem banco). Filtros: `runIds`, `since` (data ou ISO;
 * comparado como INSTANTE com o created_at — comparar texto errava o mesmo dia: o SQLite grava
 * 'YYYY-MM-DD HH:MM:SS' com espaço, o ISO usa 'T' (0x54 > 0x20) e toda linha do dia do `since`
 * caía fora) e `stagePrefix`. `since` ilegível cai na comparação de texto (fail-open). Devolve
 * total + quebras por etapa, modelo, engine, run e motivo de fallback.
 */
export function summarizeUsageRows(rows, { runIds = null, since = null, stagePrefix = null } = {}) {
  const runSet = runIds ? new Set(runIds.map(Number)) : null;
  const sinceMs = since ? utcMs(since) : Number.NaN;
  const afterSince = (r) =>
    Number.isFinite(sinceMs) ? utcMs(r.created_at) >= sinceMs : String(r.created_at || '') >= String(since);
  const filtered = rows.filter(
    (r) =>
      (!runSet || runSet.has(Number(r.run_id))) &&
      (!since || afterSince(r)) &&
      (!stagePrefix || String(r.stage || '').startsWith(stagePrefix)),
  );
  const total = emptyBucket();
  const groups = { byStage: new Map(), byModel: new Map(), byEngine: new Map(), byRun: new Map(), byFallbackReason: new Map() };
  const keyOf = {
    byStage: (r) => r.stage || '(sem stage)',
    byModel: (r) => r.model || '(sem modelo)',
    byEngine: (r) => r.engine || '(legado)',
    byRun: (r) => (r.run_id == null ? '(sem run)' : String(r.run_id)),
    byFallbackReason: (r) => r.fallback_reason || null,
  };
  for (const r of filtered) {
    addRow(total, r);
    for (const [name, map] of Object.entries(groups)) {
      const k = keyOf[name](r);
      if (k == null) continue;
      if (!map.has(k)) map.set(k, emptyBucket());
      addRow(map.get(k), r);
    }
  }
  const toObj = (map) =>
    Object.fromEntries([...map.entries()].sort((a, b) => b[1].costUsd - a[1].costUsd).map(([k, b]) => [k, finishBucket(b)]));
  return {
    total: finishBucket(total),
    byStage: toObj(groups.byStage),
    byModel: toObj(groups.byModel),
    byEngine: toObj(groups.byEngine),
    byRun: toObj(groups.byRun),
    byFallbackReason: toObj(groups.byFallbackReason),
  };
}

/**
 * Lê e resume o ledger (somente-leitura). Ledger inexistente/sem tabela = resumo vazio (o eval
 * ainda não gastou nada), nunca erro.
 */
export function summarizeLedger({ ledgerPath = LEDGER_DB, ...filters } = {}) {
  const empty = { ledgerPath, exists: false, runs: [], ...summarizeUsageRows([]) };
  if (!existsSync(ledgerPath)) return empty;
  const db = new Database(ledgerPath, { readonly: true, fileMustExist: true });
  try {
    if (!db.prepare(Q.hasTable).get('llm_usage')) return { ...empty, exists: true };
    const present = new Set(db.prepare(Q.columns).all().map((c) => c.name));
    const cols = OPTIONAL_COLUMNS.filter((c) => present.has(c));
    const rows = db.prepare(Q.usage(cols)).all();
    const runs = db.prepare(Q.hasTable).get('runs') ? db.prepare(Q.runs).all() : [];
    return { ledgerPath, exists: true, runs, ...summarizeUsageRows(rows, filters) };
  } finally {
    db.close();
  }
}

/** Linhas de texto curtas p/ o console/relatório (US$ com 6 casas: o Jev custa ~US$ 0,0003/chamada). */
export function formatLedgerSummary(summary) {
  const t = summary.total;
  const lines = [`ledger ${summary.ledgerPath}: ${t.calls} chamada(s), US$ ${t.costUsd.toFixed(6)}`];
  for (const [label, key] of [
    ['etapa', 'byStage'],
    ['engine', 'byEngine'],
    ['modelo', 'byModel'],
  ]) {
    for (const [k, b] of Object.entries(summary[key] || {})) {
      lines.push(`  ${label} ${k}: ${b.calls}× US$ ${b.costUsd.toFixed(6)} (in ${b.promptTokens} / out ${b.completionTokens})`);
    }
  }
  return lines;
}
