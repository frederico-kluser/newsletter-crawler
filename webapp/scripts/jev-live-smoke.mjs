#!/usr/bin/env node
// Teste AO VIVO do JEV (Decisions API real da OpenRouter) sobre o acervo REAL — garante que a
// filtragem funciona e mede latência. LIMITADO ao teto pedido: 25 × 30 = 750 notícias (uma onda
// de 30 lotes × 25 artigos). Lote configurável 1..25 (NC_JEV_BATCH, default 25); lotes disparados
// 30 por vez (NC_JEV_CONCURRENCY, teto 30).
//
//   OPENROUTER_API_KEY=sk-or-… node scripts/jev-live-smoke.mjs
//
// O que corre de verdade: o MOTOR completo (startRun + advanceRun) com snapshot servido em HTTP
// local, KV emulado e transporte REAL para o Jev (só o webhook fica de fora — sem URL registada).
// A chave NUNCA é gravada: lida de env, usada só no header Authorization.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { advanceRun, resolveScope, startRun } from '../api/_lib/analyze.js';
import { clampBatchSize, clampConcurrency, env, jevSettings } from '../api/_lib/env.js';
import { httpTransport } from '../api/_lib/http.js';

const KEY = process.env.OPENROUTER_API_KEY || process.env.NC_OPENROUTER_API_KEY;
if (!KEY) {
  console.error('Erro: defina OPENROUTER_API_KEY no ambiente — Solução: OPENROUTER_API_KEY=sk-or-… node scripts/jev-live-smoke.mjs');
  process.exit(2);
}

const MAX_ARTICLES = 25 * 30; // 750 — o teto pedido (uma onda completa)
const INPUT = process.env.NC_LIVE_INPUT || 'inteligência artificial, LLMs e agentes de IA';
const BATCH = clampBatchSize(Number.parseInt(process.env.NC_JEV_BATCH, 10) || 25);
const CONCURRENCY = clampConcurrency(Number.parseInt(process.env.NC_JEV_CONCURRENCY, 10) || 30);

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '../public/data');

// ---- snapshot real, servido em HTTP local (é o mesmo contrato do deployment) ----
const [metaRaw, articlesRaw] = await Promise.all([
  fs.readFile(path.join(dataDir, 'meta.json'), 'utf8'),
  fs.readFile(path.join(dataDir, 'articles.json'), 'utf8'),
]);
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/data/meta.json') return res.end(metaRaw);
  if (req.url === '/data/articles.json') return res.end(articlesRaw);
  res.statusCode = 404;
  res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- janela de datas com o MAIOR nº de artigos até 750 (janela contígua por data) ----
const meta = JSON.parse(metaRaw);
const articles = JSON.parse(articlesRaw);
const scoped = resolveScope(articles, meta, { from: '', to: '', sourceIds: [], kind: 'all' });
const byDate = new Map();
for (const a of scoped) byDate.set(a.date_iso, (byDate.get(a.date_iso) || 0) + 1);
const dates = [...byDate.keys()].sort();
let best = { from: dates[0], to: dates[0], count: 0 };
let count = 0;
for (let lo = 0, hi = 0; hi < dates.length; hi++) {
  count += byDate.get(dates[hi]);
  while (count > MAX_ARTICLES && lo < hi) {
    count -= byDate.get(dates[lo]);
    lo++;
  }
  if (count > best.count && count <= MAX_ARTICLES) best = { from: dates[lo], to: dates[hi], count };
}

// ---- KV emulado + transporte REAL para o Jev, com cronómetro por request ----
const store = new Map();
const lists = new Map();
const kvFake = async ({ body }) => {
  const parsed = JSON.parse(body);
  const pipeline = Array.isArray(parsed[0]);
  const cmds = pipeline ? parsed : [parsed];
  const results = cmds.map(([op, ...args]) => {
    switch (op) {
      case 'GET': return { result: store.has(args[0]) ? store.get(args[0]) : null };
      case 'SET': store.set(args[0], args[1]); return { result: 'OK' };
      case 'LPUSH': { const l = lists.get(args[0]) || []; l.unshift(args[1]); lists.set(args[0], l); return { result: l.length }; }
      case 'LRANGE': { const l = lists.get(args[0]) || []; return { result: l.slice(Number(args[1]), Number(args[2]) + 1) }; }
      case 'LTRIM': { const l = (lists.get(args[0]) || []).slice(Number(args[1]), Number(args[2]) + 1); lists.set(args[0], l); return { result: 'OK' }; }
      default: return { error: `unsupported ${op}` };
    }
  });
  return { statusCode: 200, body: JSON.stringify(pipeline ? { result: results } : results[0]), headers: {} };
};

const latencies = [];
let jevAttempts = 0;
const transport = async (opts) => {
  if (opts.url === process.env.KV_REST_API_URL) return kvFake(opts);
  if (opts.url === process.env.NC_JEV_BASE_URL) {
    jevAttempts++;
    const t = performance.now();
    const res = await httpTransport({ ...opts, headers: { ...opts.headers, authorization: `Bearer ${KEY}` } });
    latencies.push(performance.now() - t);
    return res;
  }
  return httpTransport(opts);
};

// ---- ambiente do teste ----
Object.assign(process.env, {
  NC_DATA_BASE_URL: base,
  NC_JEV_BATCH: String(BATCH),
  NC_JEV_CONCURRENCY: String(CONCURRENCY),
  KV_REST_API_URL: 'http://kv.fake/rest',
  KV_REST_API_TOKEN: 'fake',
});
if (!process.env.NC_JEV_BASE_URL) process.env.NC_JEV_BASE_URL = jevSettings().baseUrl;
process.env.OPENROUTER_API_KEY = KEY;

console.log(`\n=== TESTE AO VIVO DO JEV — filtragem + latência ===`);
console.log(`input: «${INPUT}»`);
console.log(`lote: ${BATCH} artigos/pedido (1..25) · lotes disparados ${CONCURRENCY} por vez (teto 30)`);
console.log(`janela: ${best.from} → ${best.to} · ${best.count} notícias (teto ${MAX_ARTICLES} = 25×30)`);

const config = {
  input: INPUT,
  from: best.from,
  to: best.to,
  sourceIds: [],
  kind: 'all',
  threshold: 0.5,
  batchSize: BATCH,
  webhookUrl: '', // sem webhook registado — a análise corre, o dispatch fica de fora
};

const t0 = performance.now();
const run = await startRun({ env, trigger: 'manual', config, transport });
const done = await advanceRun(run.id, { env, budgetMs: 300000, transport });
const wallMs = performance.now() - t0;

// ---- relatório ----
const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const stats = done.stats;
console.log(`\n--- resultado ---`);
console.log(`estado: ${done.status} · escopo ${done.scope.total} · lotes ${done.scope.batches} (ondas de ${CONCURRENCY})`);
console.log(`lote registado na run: ${done.config.batchSize} · modelo: ${done.model}`);
console.log(`vereditos: ${stats.yes} sim · ${stats.no} não · ${stats.uncertain} incerto · ${stats.noAnswer} sem resposta · ${done.injectionFlagged} em lote sinalizado (injeção)`);
console.log(`\n--- latência (por request ao Jev) ---`);
console.log(`requests: ${latencies.length} (${jevAttempts} tentativas com retries)`);
console.log(`min ${sorted[0]?.toFixed(0)} ms · p50 ${pct(50)?.toFixed(0)} ms · p95 ${pct(95)?.toFixed(0)} ms · máx ${sorted[sorted.length - 1]?.toFixed(0)} ms`);
console.log(`parede total: ${(wallMs / 1000).toFixed(1)} s · vazão ${(done.progress.processed / (wallMs / 1000)).toFixed(0)} artigos/s`);
console.log(`custo real: US$ ${done.usage.cost.toFixed(6)} (${done.usage.inputTokens} tokens de entrada · saída grátis)`);

const yes = done.matches.slice(0, 6);
console.log(`\n--- separadas (p ≥ 0.5) — amostra de ${done.matches.length} ---`);
for (const m of yes) console.log(`  p=${m.jev.p.toFixed(2)}  ${m.title.slice(0, 80)}`);

const dispatchInfo = done.dispatch?.skipped ? `dispatch: ${done.dispatch.skipped} (esperado — sem webhook no teste)` : `dispatch: ${JSON.stringify(done.dispatch)}`;
console.log(`\n${dispatchInfo}`);

// veredito de filtragem: tem de haver separação real dos dois lados
const filtered = stats.yes > 0 && stats.no > 0;
console.log(`\nveredito: ${filtered ? 'FILTRANDO (há sim e não no mesmo lote)' : done.status === 'done' ? 'concluído — sem discriminação neste input/janela (ajuste NC_LIVE_INPUT)' : 'FALHOU'} · estado ${done.status}`);

await new Promise((r) => server.close(r));
process.exit(done.status === 'done' ? 0 : 1);
