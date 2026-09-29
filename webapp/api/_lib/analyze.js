// Motor da análise JEV ("a busca completa"): escopo idêntico ao do site (fontes + from/to sobre
// date_iso, junk fora) → batches de artigos → 1 request Jev por batch (1 noul por artigo + guarda
// de injeção) → notícias SEPARADAS (p ≥ limiar) → JSON array ao webhook quando a run conclui.
//
// A run é conduzida por `advanceRun(runId, {budgetMs})`: quem chama repete até `status: 'done'`
// (a página /admin conduz via step; o cron noturno conduz num loop interno). Tudo é determinístico
// (ordenação estável data DESC, id ASC) para os batches serem os mesmos entre invocações.
import { randomUUID } from 'node:crypto';
import { applyFilters } from '../../src/lib/filters.js';
import { dataBaseUrl, DEFAULT_THRESHOLD, jevSettings, openrouterKey } from './env.js';
import { httpTransport } from './http.js';
import { batchBudgetLeft, buildBatchQuestions, buildBatchState, jevDecide, JevHttpError, verdictFor } from './jev.js';
import { createRunRecord, getRunRecord, saveRunRecord } from './kv.js';
import { dispatchWebhook } from './dispatch.js';
import { loadSnapshot } from './data.js';
import { errorLog, log, warn } from './log.js';

const MAX_MATCHES = 2000; // teto do payload/histórico (o webhook recebe o array completo até aqui)
const TERMINAL_ABORT = new Set([401, 402, 403]); // chave/créditos — não adianta repetir

/** Escopo com a MESMA semântica do site (`webapp/src/lib/filters.js`): fontes (OR) + from/to. */
export function resolveScope(articles, meta, config) {
  const filters = {
    sourceIds: Array.isArray(config.sourceIds) ? config.sourceIds.filter((n) => Number.isFinite(Number(n))).map(Number) : [],
    from: String(config.from || ''),
    to: String(config.to || ''),
    facets: {},
    kind: config.kind && config.kind !== 'all' ? config.kind : 'all',
    verify: '',
    showJunk: false, // junk não é matéria — igual ao site
  };
  const scoped = applyFilters(articles, filters, meta?.toolContentTypes || []);
  // ordem ESTÁVEL (importa: os batches são por índice e precisam de ser reprodutíveis entre passos)
  scoped.sort((a, b) => (a.date_iso < b.date_iso ? 1 : a.date_iso > b.date_iso ? -1 : Number(a.id) - Number(b.id)));
  return scoped;
}

/**
 * Batches por tamanho fixo (default 30), com guarda de orçamento do jev-core: se o state +
 * maior pergunta passarem de STATE_PLUS_LONGEST_Q × SAFETY, divide ao meio até caber.
 */
export function planBatches(items, { input, batchSize = 30 }) {
  const batches = [];
  for (let i = 0; i < items.length; ) {
    let size = Math.max(1, Math.min(batchSize, items.length - i));
    for (;;) {
      const slice = items.slice(i, i + size);
      const state = buildBatchState(slice);
      const questions = buildBatchQuestions(input, slice.length);
      if (batchBudgetLeft(state, questions) >= 0 || size === 1) {
        batches.push({ from: i, to: i + size, items: slice });
        i += size;
        break;
      }
      size = Math.max(1, Math.floor(size / 2));
    }
  }
  return batches;
}

/** Item do JSON array do webhook (metadados + resumo + veredito — SEM corpo; decisão do usuário). */
export function payloadItem(article, sourceName, verdict, model) {
  return {
    id: article.id,
    url: article.url,
    title: article.title,
    title_pt: article.title_pt || null,
    date_iso: article.date_iso,
    kind: article.kind || null,
    section: article.section || null,
    source: { id: article.source_id, name: sourceName || null },
    tags: article.tags || {},
    summary_pt: article.summary_pt || null,
    verify_status: article.verify_status || null,
    jev: { p: verdict.p, decision: verdict.decision, model: model || null, injection_flag: false },
  };
}

/** Cria a run (registo em KV) com o escopo já calculado. Não decide nada — só prepara. */
export async function startRun({ env, trigger, config, transport } = {}) {
  const { meta, articles } = await loadSnapshot(dataBaseUrl());
  const scoped = resolveScope(articles, meta, config);
  const settings = jevSettings();
  const batches = planBatches(scoped, { input: config.input, batchSize: settings.batchSize });
  const now = new Date().toISOString();
  const run = {
    id: randomUUID().slice(0, 18),
    trigger,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    config: {
      input: config.input,
      from: config.from || '',
      to: config.to || '',
      sourceIds: Array.isArray(config.sourceIds) ? config.sourceIds.map(Number) : [],
      kind: config.kind || 'all',
      threshold: Number(config.threshold) || DEFAULT_THRESHOLD,
      webhookUrl: config.webhookUrl || '',
    },
    scope: { total: scoped.length, batches: batches.length, batchSize: settings.batchSize },
    progress: { done: 0, total: batches.length, processed: 0 },
    stats: { yes: 0, no: 0, uncertain: 0, noAnswer: 0 },
    injectionFlagged: 0,
    matches: [],
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
    model: null,
    dispatch: null,
    lastError: null,
    error: null,
  };
  await createRunRecord(run, env, transport);
  log(`run ${run.id} criada (${trigger}): ${scoped.length} artigos no escopo, ${batches.length} batches`);
  return run;
}

/**
 * Avança a run até `budgetMs` esgotar ou terminar. Ao terminar dispara o webhook (uma vez).
 * Falha de batch NÃO terminal mantém `status: 'running'` + `lastError` (o próximo passo repete);
 * 401/402/403 abortam com `status: 'error'`.
 */
export async function advanceRun(runId, { env, budgetMs = 20000, transport = httpTransport, forceDispatch = false } = {}) {
  const run = await getRunRecord(runId, env, transport);
  if (!run) {
    const err = new Error(`run ${runId} não encontrada`);
    err.code = 'run-not-found';
    throw err;
  }
  if (run.status !== 'running') return run;

  const settings = jevSettings();
  const apiKey = openrouterKey();
  const deadline = Date.now() + budgetMs;
  const { meta, articles } = await loadSnapshot(dataBaseUrl());
  const scoped = resolveScope(articles, meta, run.config);
  const batches = planBatches(scoped, { input: run.config.input, batchSize: run.scope.batchSize || settings.batchSize });
  if (batches.length !== run.progress.total) {
    warn(`run ${run.id}: snapshot mudou (${run.progress.total} → ${batches.length} batches) — a seguir do ponto atual`);
    run.progress.total = batches.length;
  }

  const sourceName = new Map((meta?.sources || []).map((s) => [Number(s.id), s.name]));

  while (Date.now() < deadline && run.progress.done < batches.length) {
    const slice = batches.slice(run.progress.done, run.progress.done + settings.concurrency);
    const results = await Promise.allSettled(
      slice.map((batch) => processBatch(batch, { run, apiKey, settings, threshold: run.config.threshold, sourceName, transport })),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        const err = r.reason;
        if (err instanceof JevHttpError && TERMINAL_ABORT.has(err.status)) {
          run.status = 'error';
          run.error = `Jev HTTP ${err.status}: ${err.message}`;
          run.finishedAt = new Date().toISOString();
          run.updatedAt = run.finishedAt;
          await saveRunRecord(run, env, transport);
          errorLog(`run ${run.id} abortada: ${run.error}`);
          return run;
        }
        run.lastError = String(err?.message || err);
        warn(`run ${run.id}: batch falhou (${run.lastError}) — para aqui; o próximo passo repete`);
        run.updatedAt = new Date().toISOString();
        await saveRunRecord(run, env, transport);
        return run;
      }
    }
    run.progress.done += slice.length;
    run.updatedAt = new Date().toISOString();
    await saveRunRecord(run, env, transport);
    log(`run ${run.id}: ${run.progress.done}/${run.progress.total} batches · ${run.matches.length} separadas · US$ ${run.usage.cost.toFixed(4)}`);
  }

  if (run.progress.done >= run.progress.total) {
    run.status = 'done';
    run.finishedAt = new Date().toISOString();
    run.updatedAt = run.finishedAt;
    run.dispatch = await finishDispatch(run, { env, transport, force: forceDispatch });
    await saveRunRecord(run, env, transport);
    log(`run ${run.id} concluída: ${run.matches.length} separadas · dispatch ${run.dispatch.ok ? 'ok' : run.dispatch.skipped || `falhou (${run.dispatch.error})`}`);
  } else {
    run.updatedAt = new Date().toISOString();
    await saveRunRecord(run, env, transport);
  }
  return run;
}

async function processBatch(batch, { run, apiKey, settings, threshold, sourceName, transport }) {
  const state = buildBatchState(batch.items);
  const questions = buildBatchQuestions(run.config.input, batch.items.length);
  const res = await jevDecide({
    state,
    questions,
    model: settings.model,
    apiKey,
    baseUrl: settings.baseUrl,
    transport,
    timeoutMs: settings.timeoutMs,
    maxAttempts: settings.maxAttempts,
  });
  run.usage.requests += 1;
  run.usage.inputTokens += res.usage.inputTokens;
  run.usage.outputTokens += res.usage.outputTokens;
  run.usage.cost += res.usage.cost;
  run.model = res.model;

  // guarda de injeção POR REQUEST: lote sinalizado ⇒ nenhum item dele dispara (fica marcado)
  const inj = verdictFor(res.answers, 'injection', 0.5);
  const flagged = inj.p != null && inj.p >= 0.5;

  for (let i = 0; i < batch.items.length; i++) {
    const item = batch.items[i];
    const verdict = verdictFor(res.answers, `q${i + 1}`, threshold);
    run.progress.processed += 1;
    if (verdict.p == null) run.stats.noAnswer += 1;
    else if (verdict.decision === 'yes') run.stats.yes += 1;
    else if (verdict.decision === 'no') run.stats.no += 1;
    else run.stats.uncertain += 1;

    if (flagged) {
      run.injectionFlagged += 1;
      continue;
    }
    if (verdict.decision === 'yes' && run.matches.length < MAX_MATCHES) {
      run.matches.push(payloadItem(item, sourceName.get(Number(item.source_id)), verdict, res.model));
    }
  }
}

async function finishDispatch(run, { env, transport, force }) {
  if (!run.matches.length && !force) return { ok: false, skipped: 'no-matches', status: 0, attempts: 0, error: null };
  if (!run.config.webhookUrl) return { ok: false, skipped: 'no-webhook', status: 0, attempts: 0, error: null };
  const result = await dispatchWebhook({
    url: run.config.webhookUrl,
    items: run.matches,
    secret: env('WEBHOOK_SECRET'),
    runId: run.id,
    trigger: run.trigger,
    transport,
  });
  return { ...result, dispatchedAt: new Date().toISOString() };
}

/** Reenvio manual do array da run ao webhook (botão da página). */
export async function redispatchRun(runId, { env, transport = httpTransport } = {}) {
  const run = await getRunRecord(runId, env, transport);
  if (!run) {
    const err = new Error(`run ${runId} não encontrada`);
    err.code = 'run-not-found';
    throw err;
  }
  run.dispatch = await finishDispatch(run, { env, transport, force: true });
  run.updatedAt = new Date().toISOString();
  await saveRunRecord(run, env, transport);
  return run;
}

/** Visão da run p/ a API: matches limitados (a lista completa fica no registo KV). */
export function runView(run) {
  if (!run) return null;
  const matches = Array.isArray(run.matches) ? run.matches : [];
  return { ...run, matches: matches.slice(0, 200), matchesTotal: matches.length };
}
