// Implementação dos comandos (sem efeito colateral ao importar) — compartilhada entre a CLI
// (src/index.js) e a UI (src/ui/). Os comandos logam por util log/warn/errorLog, então a UI
// captura tudo via setLogSink. As contagens vêm de getStatus() (dado), reusado pela UI.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stmts, wipeAll, removeSource } from './db.js';
import {
  ROOT, EXPORT_DIR, DB_PATH, CONCURRENCY, MAX_RETRIES, HAS_LLM, CLASSIFY_AFTER_CRAWL, SUMMARIZE_AFTER_CRAWL,
  SEARCH_MODE_A_CONFIRM, OPENROUTER_API_KEY, ENV_PATH, BUDGET_USD, MAX_PARALLEL, RAM_MAX_PCT,
  AGGRESSIVE_DEFAULT, VERIFY_AFTER_CRAWL, VERIFY_STREAMING, JOB_TIMEOUT_MS, JOB_HARD_TIMEOUT_MS,
  CLASSIFY_STREAMING, SUMMARIZE_STREAMING, CURATE_JOBS, ROUNDUP_TIMEOUT_MS, COST_LOG_INTERVAL_MS,
  defaultParallel, loadSources, addSourceToConfig, removeSourceFromConfig, setRuntimeKey,
} from './config.js';
import {
  initGovernor, stopGovernor, setProfile, jobsCapacity, getTelemetry,
} from './governor.js';
import { beginRun, endRun, shouldStop, getBudgetState } from './budget.js';
import { processJob, enqueue, upsertSource } from './crawl.js';
import { detectSourceType } from './detect-type.js';
import { exportWebSnapshot } from './export-web.js';
import { exportPublicApi } from './export-api.js';
import { classifyPending, classifyArticleRow } from './classify.js';
import { summarizePending, summarizeArticleRow } from './summarize.js';
import { verifyPending, verifyArticleRow, recleanSuspects } from './verify.js';
import { runSearch, getSearchProgress } from './search.js';
import { closeBrowser } from './fetch.js';
import { closeParsePool } from './parse-pool.js';
import { logEvent, flushEvents } from './events.js';
import { createJobClock } from './deadline.js';
import {
  progressReset, progressSnapshot, sourceSeen, sourceListingDone, bump, inStage,
} from './progress.js';
import { runEventsReset, emitRunEvent } from './run-events.js';
import { startWebServer } from './web.js';
import { probeOpenRouterKey, upsertEnvVar, maskKey } from './keys.js';
import { slugify, normalizeUrl, parseDate, hostOf, log, warn, errorLog, debug } from './util.js';

// Re-export p/ a UI importar de um lugar só (igual getStatus).
export { getSearchProgress };

/** Artigo completo por id (SELECT a.* + source_name) p/ a preview da TUI. Síncrono e barato. */
export function getArticle(id) {
  return stmts.webGetArticle.get(id) ?? null;
}

/**
 * Deadline por job: corre `promise` contra um timeout de `ms`; estourou, REJEITA com
 * code JOB_TIMEOUT (o dispatch mantém a ficha com o blurb e marca "enriquecer depois"). A
 * promise abandonada segue rodando ao fundo, mas suas escritas são idempotentes
 * (INSERT OR IGNORE / UPDATE), então uma conclusão tardia é inofensiva. ms<=0 desliga.
 * Exportado p/ teste (padrão do repo, como createBreaker/createHostGate).
 */
export function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const e = new Error(`job excedeu o deadline de ${ms}ms`);
      e.code = 'JOB_TIMEOUT';
      reject(e);
    }, ms);
    t.unref?.();
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (err) => { clearTimeout(t); reject(err); },
    );
  });
}

/** Telemetria viva (governador + orçamento + progresso da run) p/ o painel da UI pollar. */
export function getRunTelemetry() {
  return { governor: getTelemetry(), budget: getBudgetState(), progress: progressSnapshot() };
}

/** Linha periódica de progresso do CLI (a TUI tem o painel; isto cobre o `npm run crawl` puro). */
function cliProgressLine() {
  const p = progressSnapshot();
  if (!p.active) return null;
  const f = getStatus().frontier;
  const c = p.counts;
  const novos = (c.salvos || 0) + (c.enriquecidos || 0);
  const parts = [
    `fontes ${p.sourcesListingDone}/${p.sourcesTotal}`,
    `artigos +${novos}${c.mantidosBlurb ? ` (+${c.mantidosBlurb} blurb)` : ''}`,
    `fila ${f.pending}p/${f.in_progress}a/${f.done}d/${f.failed}x`,
  ];
  if (c.itensCurados) parts.push(`curados +${c.itensCurados}`);
  if (c.classificados || c.resumidos || c.verificados) {
    parts.push(`pós ${c.verificados || 0}v/${c.resumidos || 0}r/${c.classificados || 0}c`);
  }
  const agora = Object.entries(p.stages).map(([k, n]) => `${n} ${k}`).join(' ');
  if (agora) parts.push(`agora: ${agora}`);
  if (c.estouros) parts.push(`estouros ${c.estouros}`);
  if (p.since && p.pctGlobal != null) {
    const semData = p.sources.filter((s) => s.pct == null).length;
    parts.push(`alvo ${p.since}: ${p.pctGlobal}%${semData ? ` (${semData} fonte(s) s/ data)` : ''}`);
  }
  return `progresso: ${parts.join(' · ')}`;
}

/**
 * Envelope de execução com limites: valida --budget/--parallel, sobe o governador no perfil
 * do comando e abre o run do ledger; endRun (extrato) e stopGovernor rodam SEMPRE (finally).
 */
async function runWithLimits({ command, flags = {}, profile }, fn) {
  const budgetUsd = flags.budget != null ? Number(flags.budget) : BUDGET_USD;
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) {
    errorLog(`--budget inválido (USD >= 0, 0 = ilimitado): ${flags.budget}`);
    process.exit(1);
  }
  const parallel = flags.parallel != null ? Number(flags.parallel) : undefined;
  if (flags.parallel != null && (!Number.isFinite(parallel) || parallel < 1)) {
    errorLog(`--parallel inválido (inteiro >= 1): ${flags.parallel}`);
    process.exit(1);
  }
  // Freio de emergência do governador: RAM crítica sustentada -> recicla o browser (o getter
  // lazy de fetch.js relança sozinho no próximo render).
  initGovernor({ parallel, profile, onEmergencyBrake: () => void closeBrowser().catch(() => {}) });
  beginRun({ command, budgetUsd, args: flags });
  let failed = false;
  try {
    return await fn();
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    flushEvents(); // grava o que sobrou no buffer de eventos (escritas em lote) antes de fechar
    endRun(failed ? 'failed' : undefined);
    stopGovernor();
  }
}

/** Contagens do banco como DADO (reusado pela UI e pelo printStatus). */
export function getStatus() {
  const f = Object.fromEntries(stmts.countFrontierByState.all().map((r) => [r.state, r.c]));
  const articles = stmts.countArticles.get().c;
  const classified = stmts.countClassifications.get().c;
  const summaries = stmts.countSummaries.get().c;
  // Gasto LLM acumulado (ledger). Aditivo e tolerante: telemetria não pode derrubar o status.
  let spend = { totalUsd: 0, calls: 0, lastRun: null };
  try {
    const t = stmts.sumUsageTotal.get();
    spend = { totalUsd: t.usd, calls: t.n, lastRun: stmts.getLastRun.get() || null };
  } catch {
    /* tabelas do ledger ausentes (DB antigo): segue sem gasto */
  }
  return {
    spend,
    sources: stmts.countSources.get().c,
    pages: stmts.countPages.get().c,
    articles,
    selectors: stmts.countSelectors.get().c,
    classified,
    pendingClassif: Math.max(0, articles - classified),
    summaries,
    pendingSummary: Math.max(0, articles - summaries),
    frontier: {
      pending: f.pending || 0,
      in_progress: f.in_progress || 0,
      done: f.done || 0,
      failed: f.failed || 0,
    },
  };
}

/**
 * Escopo efetivo da busca (delta vs acervo) + contagem DESSE escopo — a MESMA conta para o
 * guard de custo do CLI e para a confirmação da TUI (que antes contava o acervo inteiro).
 * A âncora do delta é a última run QUE TROUXE ARTIGOS (maxArticleRunId), não MAX(runs.id):
 * buscas/verify também abrem runs, e ancorar nelas zeraria o "apenas o novo".
 */
export function getSearchScope(flags = {}) {
  const latest = stmts.maxArticleRunId.get().id;
  const all = flags.all === true || latest == null;
  return {
    all,
    runId: all ? null : latest,
    count: all ? stmts.countArticles.get().c : stmts.countArticlesByRun.get(latest).c,
  };
}

export function printStatus() {
  const s = getStatus();
  log('— status —');
  log(`sources:   ${s.sources}`);
  log(`pages:     ${s.pages}`);
  log(`articles:  ${s.articles}`);
  log(`selectors: ${s.selectors}`);
  log(`classif.:  done=${s.classified} pending=${s.pendingClassif}`);
  log(`resumos:   done=${s.summaries} pending=${s.pendingSummary}`);
  log(`gasto LLM: US$ ${s.spend.totalUsd.toFixed(4)} em ${s.spend.calls} chamadas`);
  log(
    `frontier:  pending=${s.frontier.pending} in_progress=${s.frontier.in_progress} ` +
      `done=${s.frontier.done} failed=${s.frontier.failed}`,
  );
}

// `--sources "A,B"`: lista por vírgula (o checkbox de fontes da TUI emite isto). Cada item casa
// por nome exato (case-insensitive) OU URL normalizada — a mesma regra do --source. Puro p/
// teste: devolve {selected, unmatched}; sem flag (ou vazia), selected = todas as fontes.
export function filterSeedSources(sources, flags) {
  const list = typeof flags.sources === 'string'
    ? flags.sources.split(',').map((x) => x.trim()).filter(Boolean)
    : null;
  if (!list || !list.length) return { selected: sources, unmatched: [] };
  const matches = (s, want) =>
    (s.name || '').toLowerCase() === want.toLowerCase() ||
    (normalizeUrl(want) != null && normalizeUrl(want) === normalizeUrl(s.url));
  return {
    selected: sources.filter((s) => list.some((w) => matches(s, w))),
    unmatched: list.filter((w) => !sources.some((s) => matches(s, w))),
  };
}

export async function cmdCrawl(flags) {
  return runWithLimits({ command: 'crawl', flags, profile: 'crawl' }, () => crawlRun(flags));
}

async function crawlRun(flags) {
  if (!HAS_LLM) {
    log('AVISO: OPENROUTER_API_KEY ausente — só o caminho estático/cache roda; sem derivação de seletor.');
  }

  // Resume: jobs que ficaram travados voltam para a fila.
  const reset = stmts.resetInProgress.run();
  if (reset.changes) log(`resume: ${reset.changes} jobs in_progress -> pending`);

  // Marca d'água do delta: REUSA o run do ledger (aberto por runWithLimits/beginRun). Antes
  // havia um segundo INSERT aqui (startDeltaRun) — duplicava a linha de runs a cada crawl e
  // crashava em DBs criados pelo branch robot-bypass (runs.command NOT NULL). Fallback
  // defensivo só p/ o caso de o ledger não ter conseguido abrir o run.
  let runId = getBudgetState().runId;
  if (runId == null) {
    try {
      runId = stmts.startDeltaRun.get().id;
    } catch (e) {
      warn(`runs: sem marca d'água do delta (${e.message}) — artigos desta run ficarão sem run_id`);
    }
  }

  // --since <YYYY-MM-DD|ISO>: piso de data (coleta do mais novo até esse piso e para). Aplica
  // à data da issue E do artigo. Data inválida aborta (em vez de ignorar o filtro silenciosamente).
  // Parseado ANTES do seed p/ o rastreador de progresso nascer já com a data-alvo (% por fonte).
  const sinceRaw = typeof flags.since === 'string' ? flags.since : null;
  const sinceDate = sinceRaw ? parseDate(sinceRaw) : null;
  if (sinceRaw && !sinceDate) {
    errorLog(`--since inválido (use ISO, ex.: 2026-06-25): ${sinceRaw}`);
    process.exit(1);
  }
  if (sinceDate) log(`--since ativo: piso ${sinceDate.toISOString()}`);
  progressReset({ sinceDate });
  runEventsReset(); // zera o feed de MARCOS do painel (o ring é global ao processo, como o progresso)

  // Re-crawl incremental: por padrão re-visita as listagens das fontes a cada execução (só enfileira
  // o novo; a dedup de artigo impede re-baixar o existente). `--no-refresh` desliga a re-visita.
  const noRefresh = flags['no-refresh'] === true;

  // Seleção de fonte ao executar: `--sources "A,B"` (lista por vírgula — o checkbox da TUI)
  // tem PRECEDÊNCIA; `--source "<nome exato>"` (ou a URL) seleciona UMA fonte; `--only <substr>`
  // casa por substring no nome/url. Sem nenhum, semeia todas do config.
  const only = typeof flags.only === 'string' ? flags.only.toLowerCase() : null;
  const sourceExact = typeof flags.source === 'string' ? flags.source.toLowerCase() : null;
  const hasSourcesList = typeof flags.sources === 'string' && flags.sources.trim() !== '';
  if (hasSourcesList && (only || sourceExact)) {
    warn('--sources tem precedência: ignorando --source/--only');
  }
  const { selected, unmatched } = filterSeedSources(loadSources(), flags);
  for (const w of unmatched) warn(`--sources: nenhuma fonte casa com "${w}"`);
  for (const s of selected) {
    if (!hasSourcesList) {
      if (only && !`${s.name || ''} ${s.url}`.toLowerCase().includes(only)) continue;
      if (
        sourceExact &&
        (s.name || '').toLowerCase() !== sourceExact &&
        normalizeUrl(s.url) !== normalizeUrl(flags.source)
      ) {
        continue;
      }
    }
    const src = upsertSource(s);
    sourceSeen(src.id, src.name || s.name || hostOf(s.url)); // painel: fontes x/y + % por data
    const seeded = enqueue(s.url, 'listing', null, src.id, 0);
    if (seeded) log(`seed: ${s.url} (type=${src.type})`);
    else if (!noRefresh) {
      const r = stmts.refreshListing.run(src.base_url); // base_url normalizada = url no frontier
      if (r.changes) log(`refresh: ${s.url} re-enfileirado (re-visita a listagem)`);
    }
    // "Enriquecer depois": re-ativa jobs de itens que ficaram só com o blurb (needs_enrich=1),
    // inclusive os cortados por deadline num run anterior — o dado ganha o corpo do alvo agora.
    const re = stmts.requeueNeedsEnrichForSource.run(src.id);
    if (re.changes) log(`enriquecer: ${re.changes} item(ns) só-blurb re-enfileirado(s) p/ pegar o corpo do alvo`);
  }

  // Agressivo é o DEFAULT (CRAWLER_AGGRESSIVE=false ou --no-aggressive desligam por completo;
  // --aggressive força mesmo com env desligada). Páginas de desafio continuam descartadas.
  const aggressive =
    flags['no-aggressive'] === true ? false : flags.aggressive === true ? true : AGGRESSIVE_DEFAULT;
  const opts = {
    maxPages: flags['max-pages'] ? Number(flags['max-pages']) : Infinity,
    sinceDate,
    aggressive,
    runId,
  };
  if (opts.aggressive) {
    log('modo agressivo ATIVO (default): ignorando robots.txt + User-Agent de navegador real (--no-aggressive p/ modo educado)');
  } else {
    log('modo educado: respeitando robots.txt e UA de bot');
  }
  const maxArticles = flags['max-articles'] ? Number(flags['max-articles']) : Infinity;

  // Capacidade DINÂMICA do loop: o governador redimensiona as lanes fetch+render pela RAM;
  // env CONCURRENCY > 0 vira teto duro por cima. Sem gate p-limit: o próprio loop é o gate
  // (as lanes de fetch/render dentro do job limitam o trabalho pesado).
  const capacity = () =>
    CONCURRENCY > 0 ? Math.min(CONCURRENCY, jobsCapacity()) : jobsCapacity();
  // Curadoria (listing/roundup) tem POOL PRÓPRIO: a fase de LLM longa não deve ocupar a capacity
  // de fetch/render dos artigos (senão uma curadoria lenta trava o fetch). Default derivado do
  // porte da máquina; CURATE_JOBS > 0 é teto duro por env.
  const curateCapacity = () =>
    CURATE_JOBS > 0 ? CURATE_JOBS : Math.max(2, Math.ceil(MAX_PARALLEL / 4));
  const inflight = new Set(); // jobs de ARTIGO (limitados por fetch+render)
  const curating = new Set(); // jobs de listing/roundup (pool próprio; fase LLM longa)
  const streaming = new Set(); // pós-save: verify+summarize+classify (lane llm; NÃO conta na capacity)
  let processedArticles = 0;
  let budgetRequeued = 0;
  let timedOut = 0;

  // STREAMING pós-save: logo após salvar/enriquecer uma ficha, roda verify + summarize + classify
  // na FOLGA da lane llm (cada um idempotente, engolindo erro/orçamento). Rastreado num set à parte
  // p/ o loop esperar sem roubar capacidade de fetch/render. Os sweeps pós-crawl seguem como rede
  // de segurança (delta-only) p/ o que sobrar (blurb-only nunca enriquecido, pulados por orçamento).
  const track = (task) => {
    const p = task().finally(() => streaming.delete(p));
    streaming.add(p);
  };
  const streamPostSave = (savedUrl) => {
    if (!(HAS_LLM && savedUrl) || shouldStop()) return;
    const a = stmts.getArticleFullByUrl.get(savedUrl);
    if (!a) return; // sumiu: pula
    if (VERIFY_STREAMING && a.verify_status == null) {
      track(() => inStage('verificação', async () => {
        try {
          await verifyArticleRow(a, { runId });
          bump('verificados');
        } catch (e) {
          if (e?.code !== 'BUDGET_EXCEEDED') debug(`verify streaming falhou (${savedUrl}): ${e.message}`);
        }
      }));
    }
    if (SUMMARIZE_STREAMING && a.summary_pt == null) {
      track(() => inStage('resumo', async () => {
        try {
          await summarizeArticleRow(a);
          bump('resumidos');
        } catch (e) {
          if (e?.code !== 'BUDGET_EXCEEDED') debug(`summarize streaming falhou (${savedUrl}): ${e.message}`);
        }
      }));
    }
    if (CLASSIFY_STREAMING && !stmts.getClassification.get(a.id)) {
      track(() => inStage('classificação', async () => {
        try {
          await classifyArticleRow(a);
          bump('classificados');
        } catch (e) {
          if (e?.code !== 'BUDGET_EXCEEDED') debug(`classify streaming falhou (${savedUrl}): ${e.message}`);
        }
      }));
    }
  };

  // Deadline vem do POOL (artigo = JOB_TIMEOUT_MS; curadoria = ROUNDUP_TIMEOUT_MS, default 0 = sem
  // corte). `set` é o pool que rastreia o job (inflight p/ artigo, curating p/ listing/roundup).
  // ARTIGO usa o relógio de TRABALHO (createJobClock): só fetch/render/parse contam; espera de
  // fila (lanes/politeness) e fases LLM ficam de fora (têm timeouts/orçamento próprios). Ao
  // estourar, o job é ABORTADO de verdade (AbortSignal) — sem zumbi segurando lane (a causa da
  // cascata de 100% de estouros). JOB_HARD_TIMEOUT_MS é o teto DURO de parede (rede de segurança).
  const dispatch = (job, set, deadline) => {
    const p = (async () => {
      const clock = job.kind === 'article' && deadline > 0 ? createJobClock(deadline) : null;
      const jobOpts = clock ? { ...opts, clock, signal: clock.signal } : opts;
      try {
        const work = processJob(job, jobOpts);
        const res = await (clock
          ? JOB_HARD_TIMEOUT_MS > 0
            ? withTimeout(work, JOB_HARD_TIMEOUT_MS)
            : work
          : withTimeout(work, deadline)); // curadoria: deadline de parede antigo (0 = sem corte)
        if (job.kind === 'article') processedArticles++;
        if (job.kind === 'listing') sourceListingDone(job.source_id); // fonte: descoberta concluída
        stmts.finish.run('done', job.url);
        if (res?.verifyUrl) streamPostSave(res.verifyUrl); // salvou/enriqueceu -> pós-processa já
      } catch (e) {
        if (e?.code === 'BUDGET_EXCEEDED') {
          // Orçamento: devolve à fila SEM consumir retry — retomável no próximo run. O loop
          // já parou de reivindicar (shouldStop), então não há hot-loop aqui.
          stmts.finish.run('pending', job.url);
          budgetRequeued++;
          return;
        }
        // Teto duro disparou (withTimeout) com o clock ainda vivo: aborta o trabalho em voo
        // p/ ele não virar zumbi (é exatamente o buraco do withTimeout puro).
        if (e?.code === 'JOB_TIMEOUT' && clock && !clock.expired()) clock.abort('hard-cap');
        // O abort pode aflorar como erro de cancelamento (got/SDK), então o veredito de
        // timeout vem do relógio, não só do code do erro.
        if (e?.code === 'JOB_TIMEOUT' || clock?.expired()) {
          timedOut++;
          bump('estouros');
          emitRunEvent({ phase: 'articles', kind: 'timeout', level: 'warn', detail: job.url.slice(0, 70) });
          logEvent({
            runId, url: job.url, stage: 'job', status: 'timeout',
            detail: { ms: deadline, kind: job.kind, ...(clock ? clock.snapshot() : {}) },
          });
          const row = job.kind === 'article' ? stmts.getArticleFullByUrl.get(normalizeUrl(job.url) || job.url) : null;
          if (row?.needs_enrich) {
            // A ficha JÁ existe com o blurb do agregador: encerra o job (não re-tenta agora, senão
            // trava de novo) e deixa needs_enrich=1 — o próximo crawl re-enfileira p/ enriquecer.
            stmts.finish.run('done', job.url);
            log(`job estourou ${deadline}ms de trabalho — ficha mantida com o blurb (enriquece depois): ${job.url.slice(0, 70)}`);
            return;
          }
          // avulso/listing/roundup: sem ficha a preservar — trata como falha comum (retry/fail).
          errorLog(`job estourou o deadline (${job.kind} ${job.url})`);
        } else {
          errorLog(`job falhou (${job.kind} ${job.url}): ${e.message}`);
        }
        const r = stmts.getRetries.get(job.url);
        if ((r?.retries ?? 0) < MAX_RETRIES) stmts.bumpRetry.run(job.url);
        else stmts.finish.run('failed', job.url);
      }
    })().finally(() => set.delete(p));
    set.add(p);
  };

  // Custo + PROGRESSO ao vivo no CLI: timer independente do fim dos jobs (mais "tempo real" que
  // esperar um job fechar). unref p/ não segurar o processo; só loga quando o valor mudou.
  let lastLoggedCalls = -1;
  let lastProgressLine = '';
  const costTimer = setInterval(() => {
    const bs = getBudgetState();
    if (bs.calls > 0 && bs.calls !== lastLoggedCalls) {
      lastLoggedCalls = bs.calls;
      log(
        `gasto parcial: US$ ${bs.spentUsd.toFixed(4)} em ${bs.calls} chamadas` +
          `${bs.budgetUsd > 0 ? ` / teto US$ ${bs.budgetUsd.toFixed(2)}` : ''}`,
      );
    }
    const line = cliProgressLine();
    if (line && line !== lastProgressLine) {
      lastProgressLine = line;
      log(line);
    }
  }, COST_LOG_INTERVAL_MS);
  costTimer.unref?.();

  emitRunEvent({ phase: 'discovery', kind: 'phase-start', detail: 'Descoberta' });
  for (;;) {
    // Artigos: limitados pela capacity de fetch+render (+ --max-articles).
    while (processedArticles < maxArticles && !shouldStop() && inflight.size < capacity()) {
      const job = stmts.claimNextArticle.get();
      if (!job) break;
      dispatch(job, inflight, JOB_TIMEOUT_MS);
    }
    // Curadoria: pool PRÓPRIO (não rouba a capacity dos artigos). --max-articles também trava aqui
    // (não faz sentido curar issue nova quando o teto de artigos já foi atingido).
    while (processedArticles < maxArticles && !shouldStop() && curating.size < curateCapacity()) {
      const job = stmts.claimNextCurate.get();
      if (!job) break;
      dispatch(job, curating, ROUNDUP_TIMEOUT_MS);
    }
    if (inflight.size === 0 && curating.size === 0 && streaming.size === 0) break; // nada => fim
    await Promise.race([...inflight, ...curating, ...streaming]);
  }
  clearInterval(costTimer);
  await Promise.allSettled([...inflight, ...curating, ...streaming]);
  await closeBrowser();
  await closeParsePool(); // encerra os workers de parsing (o pós-crawl não parseia HTML)
  if (budgetRequeued) log(`orçamento: ${budgetRequeued} jobs devolvidos à fila (retomáveis no próximo run)`);
  if (timedOut) log(`deadline: ${timedOut} job(s) cortado(s) em ${JOB_TIMEOUT_MS}ms de TRABALHO (fila/LLM não contam; ficha mantida com o blurb; detalhe por fase no ncrawl inspect)`);
  log('crawl concluído.');
  emitRunEvent({ phase: 'articles', kind: 'phase-end', level: 'success', detail: `${processedArticles} artigos` });

  // Registra na run quantos artigos novos ela descobriu (o delta desta execução).
  if (runId != null) {
    const newCount = stmts.countArticlesByRun.get(runId).c;
    stmts.finishDeltaRun.run(newCount, runId);
    log(`run ${runId}: ${newCount} novo(s) artigo(s) desde a última execução.`);
    emitRunEvent({ phase: 'post', kind: 'run-summary', level: 'success', detail: `${newCount} novos` });
  }

  // Hooks pós-crawl EM PARALELO (verify, classify e summarize são independentes — todos só
  // leem articles e escrevem colunas/tabelas próprias); o perfil llm-only dá o teto à lane llm.
  const post = [];
  if (VERIFY_AFTER_CRAWL && HAS_LLM && flags['no-verify'] !== true && !shouldStop()) {
    post.push(verifyPending({}).catch((e) => errorLog(`verify pós-crawl falhou: ${e.message}`)));
  }
  if (CLASSIFY_AFTER_CRAWL && HAS_LLM && flags['no-classify'] !== true && !shouldStop()) {
    post.push(classifyPending({}).catch((e) => errorLog(`classify pós-crawl falhou: ${e.message}`)));
  }
  if (SUMMARIZE_AFTER_CRAWL && HAS_LLM && flags['no-summarize'] !== true && !shouldStop()) {
    post.push(summarizePending({}).catch((e) => errorLog(`summarize pós-crawl falhou: ${e.message}`)));
  }
  if (post.length) {
    setProfile('llm-only');
    emitRunEvent({ phase: 'post', kind: 'phase-start', detail: 'Pós-processamento' });
    await Promise.all(post);
  } else if (shouldStop()) {
    log('orçamento atingido: verify/classify/summarize pulados — retome com os comandos diretos');
  }

  printStatus();
}

// Adiciona uma fonte. O TIPO (index|listing) é DETECTADO automaticamente (o usuário não precisa
// saber a diferença): sem --type, roda a detecção por IA (sob governador/orçamento/ledger, p/ o
// custo aparecer e as lanes existirem) e persiste o resultado; --type continua forçando manual.
export async function cmdAdd(rest, flags) {
  const url = rest[0];
  if (!url) {
    errorLog('uso: add <url> [--name "Nome"] [--type index|listing] [--max-index-pages N]');
    process.exit(1);
  }
  const explicitType = typeof flags.type === 'string' ? flags.type : undefined;
  let type = explicitType;
  let detection = null;
  if (!explicitType) {
    detection = await runWithLimits({ command: 'add', flags, profile: 'llm-only' }, () =>
      detectSourceType(url, { aggressive: AGGRESSIVE_DEFAULT }));
    type = detection.type;
    log(
      `tipo detectado: ${type} ` +
        `(${detection.source === 'llm' ? 'IA' : 'heurística'}, ${Math.round(detection.confidence * 100)}%) ` +
        `— ${detection.reason}`,
    );
  }
  const src = upsertSource({
    url,
    name: typeof flags.name === 'string' ? flags.name : undefined,
    type,
    maxIndexPages: flags['max-index-pages'] ? Number(flags['max-index-pages']) : undefined,
  });
  enqueue(url, 'listing', null, src.id, 0);
  // Persiste no sources.json do usuário (NC_HOME): permanente, aparece no seletor da UI e re-semeia todo crawl.
  const { added } = addSourceToConfig({
    url: src.base_url,
    name: src.name,
    type: src.type,
    maxIndexPages: src.max_index_pages,
  });
  log(
    `fonte ${added ? 'adicionada' : 'atualizada'}: ${src.base_url} (id ${src.id}, type=${src.type}) ` +
      '— salva em sources.json (permanente)',
  );
  return { source: src, added, detection };
}

// ---- gestão de fontes (tela "Gerenciar fontes" da TUI + CLI) ----

/** Fontes + contagem de artigos (DADO p/ a TUI). */
export function listSourcesForUI() {
  return stmts.listSources.all().map((s) => ({
    id: s.id,
    name: s.name,
    base_url: s.base_url,
    type: s.type,
    articles: stmts.countArticlesBySource.get(s.id).c,
  }));
}

/** Troca o tipo de uma fonte (index<->listing) e persiste no DB + sources.json. Síncrono. */
export function setSourceType(sourceId, type) {
  const s = stmts.getSourceById.get(sourceId);
  if (!s) return { error: `fonte ${sourceId} não encontrada` };
  const next = type === 'index' ? 'index' : 'listing';
  const updated = upsertSource({
    url: s.base_url, name: s.name, type: next, maxIndexPages: s.max_index_pages,
  });
  addSourceToConfig({
    url: updated.base_url, name: updated.name, type: updated.type, maxIndexPages: updated.max_index_pages,
  });
  log(`tipo da fonte "${updated.name || updated.base_url}" -> ${updated.type}`);
  return { source: updated };
}

/** Re-detecta o tipo via IA (sob governador/orçamento) e persiste. Async. */
export async function redetectSourceType(sourceId) {
  const s = stmts.getSourceById.get(sourceId);
  if (!s) return { error: `fonte ${sourceId} não encontrada` };
  const detection = await runWithLimits({ command: 'add', flags: {}, profile: 'llm-only' }, () =>
    detectSourceType(s.base_url, { aggressive: AGGRESSIVE_DEFAULT }));
  const updated = upsertSource({
    url: s.base_url, name: s.name, type: detection.type, maxIndexPages: s.max_index_pages,
  });
  addSourceToConfig({
    url: updated.base_url, name: updated.name, type: updated.type, maxIndexPages: updated.max_index_pages,
  });
  log(
    `re-detecção "${updated.name || updated.base_url}" -> ${updated.type} ` +
      `(${detection.source === 'llm' ? 'IA' : 'heurística'}) — ${detection.reason}`,
  );
  return { source: updated, detection };
}

/**
 * Remoção COMPLETA por id (dados + descadastro do sources.json). Usado pela CLI (cmdRemove) e pela
 * TUI (tela Gerenciar fontes). Retorna { source, counts } ou { error }.
 */
export function removeSourceById(sourceId) {
  const out = removeSource(sourceId); // transação no db.js (dados + linha sources)
  if (!out) return { error: `fonte ${sourceId} não encontrada` };
  // Descadastra do sources.json (NC_HOME) p/ não voltar no próximo crawl (o seed re-semeia do JSON).
  try {
    removeSourceFromConfig(out.source.base_url);
  } catch (e) {
    warn(`sources.json: falha ao remover a fonte (${e.message})`);
  }
  return out;
}

// Remove uma fonte DE VEZ: descadastra (sources.json + linha `sources`) e apaga TODO o conteúdo
// coletado (artigos+tags/classificações, pages, frontier, events, buscas 100% dela; selectors do
// host se não compartilhados). Diferente do `purge` (que mantém a fonte cadastrada). Exige --yes.
export function cmdRemove(rest, flags) {
  const { source, error } = findOneSource(rest[0]);
  if (error) {
    errorLog(`remove: ${error}`);
    process.exit(1);
  }
  const nArticles = stmts.countArticlesBySource.get(source.id).c;
  if (flags.yes !== true) {
    errorLog(
      `remove DESCADASTRA "${source.name || source.base_url}" (id ${source.id}) e APAGA ${nArticles} ` +
        'artigo(s) + tags/classificações, pages, frontier, events e as buscas 100% dela. A fonte ' +
        'também sai do sources.json (NÃO volta no próximo crawl).',
    );
    errorLog(`Confirme com:  ncrawl remove ${JSON.stringify(rest[0])} --yes`);
    process.exit(1);
  }
  const { counts } = removeSourceById(source.id);
  log(
    `fonte "${source.name || source.base_url}" removida: ` +
      Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(' ') +
      ' — descadastrada do sources.json.',
  );
  printStatus();
}

// Limpa TODOS os dados (slate limpo). Destrutivo: exige --yes.
export function cmdReset(flags) {
  if (flags.yes !== true) {
    errorLog(
      `reset APAGA TODOS OS DADOS de ${DB_PATH} (articles, frontier, pages, selectors, ` +
        'classifications, article_tags, classification_uncovered, sources, runs, llm_usage).',
    );
    errorLog('Confirme com:  npm run reset -- --yes');
    process.exit(1);
  }
  wipeAll();
  log(`reset: todos os dados apagados (${DB_PATH}).`);
  printStatus();
}

// Agrupa as tags do artigo por faceta (preservando a ordem de rank), para o export.
function tagsByFacet(articleId) {
  const out = {};
  for (const r of stmts.getTagsForArticle.all(articleId)) {
    (out[r.facet] ||= []).push(r.tag);
  }
  return out;
}

// Markdown do artigo com frontmatter YAML das tags (só quando há classificação).
function articleMarkdown(a, facets) {
  const facetNames = Object.keys(facets);
  let fm = '';
  if (facetNames.length) {
    const lines = ['---'];
    if (a.title) lines.push(`title: ${JSON.stringify(a.title)}`);
    lines.push(`url: ${a.url}`);
    if (a.published_at) lines.push(`published_at: ${a.published_at}`);
    for (const facet of facetNames) lines.push(`${facet}: [${facets[facet].join(', ')}]`);
    lines.push('---', '');
    fm = lines.join('\n');
  }
  return (
    fm +
    `# ${a.title || ''}\n\n` +
    `> ${a.url}\n` +
    (a.published_at ? `> ${a.published_at}\n` : '') +
    (a.title_pt ? `\n## ${a.title_pt}\n` : '') +
    (a.summary_pt ? `\n${a.summary_pt}\n` : '') +
    `\n${a.content || ''}\n`
  );
}

export function cmdExport(flags) {
  // Formato web: snapshot JSON estático do acervo COMPLETO p/ o webapp (webapp/public/data),
  // COMMITADO no repo e servido pela Vercel — por isso o destino default é o REPO (ROOT), não
  // o EXPORT_DIR de NC_HOME como nos formatos md/json. Snapshot é estado, não delta.
  if (flags.format === 'web') {
    if (flags.all === true) warn('--all é ignorado no formato web (o snapshot é sempre o acervo completo).');
    const outDir = flags.out ? path.resolve(String(flags.out)) : path.join(ROOT, 'webapp', 'public', 'data');
    exportWebSnapshot({ outDir });
    // API pública dedicada e versionada (webapp/public/api/v1/corpus.json) — regenerada no MESMO
    // export que o pre-push roda. Só no destino default: um --out pontual não deve cuspir a API
    // pública noutro lugar (o snapshot web ainda respeita o --out p/ exports de inspeção).
    if (!flags.out) exportPublicApi({ outDir: path.join(ROOT, 'webapp', 'public', 'api', 'v1') });
    return;
  }
  const format = flags.format === 'json' ? 'json' : 'md';
  const outDir = EXPORT_DIR;
  mkdirSync(outDir, { recursive: true });
  // Delta: por padrão exporta só a última execução; --all (ou sem runs) exporta o acervo inteiro.
  const latest = stmts.getLatestRunId.get().id;
  const all = flags.all === true || latest == null;
  let n = 0;
  for (const s of stmts.listSources.all()) {
    const arts = all
      ? stmts.listArticlesBySource.all(s.id)
      : stmts.listArticlesForRunBySource.all(s.id, latest);
    if (!arts.length) continue;
    const dir = path.join(outDir, slugify(s.name || String(s.id)));
    mkdirSync(dir, { recursive: true });
    for (const a of arts) {
      const base = `${slugify(a.title || 'artigo')}-${a.id}`;
      const facets = tagsByFacet(a.id);
      if (format === 'json') {
        const cls = stmts.getClassification.get(a.id);
        const out = { ...a, tags: facets, classification: cls ? JSON.parse(cls.result_json) : null };
        writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(out, null, 2));
      } else {
        writeFileSync(path.join(dir, `${base}.md`), articleMarkdown(a, facets));
      }
      n++;
    }
  }
  log(`exportados ${n} artigos para ${outDir} (${format})${all ? ' [todos]' : ` [run ${latest}]`}`);
}

// Finaliza o PÓS-PROCESSAMENTO dos pendentes (verify + classify + summarize) num comando só, SEM
// novo crawl — p/ terminar/retomar um backlog interrompido. Roda os 3 sweeps EM PARALELO (colunas
// independentes) no perfil llm-only, honrando --limit/--force/--budget/--parallel e os --no-* p/
// pular um sweep. O orçamento (shouldStop) para e devolve os pendentes, então dá p/ limitar o gasto
// por execução e retomar depois. Espelha o bloco pós-crawl (crawlRun) num comando avulso.
export async function cmdFinish(flags) {
  if (!HAS_LLM) {
    errorLog('OPENROUTER_API_KEY ausente — finalizar os pendentes requer o caminho LLM.');
    process.exit(1);
  }
  const limit = flags.limit ? Number(flags.limit) : Infinity;
  const force = flags.force === true;
  await runWithLimits({ command: 'finish', flags, profile: 'llm-only' }, () => {
    const tasks = [];
    if (flags['no-verify'] !== true) {
      tasks.push(verifyPending({ limit, force }).catch((e) => errorLog(`verify falhou: ${e.message}`)));
    }
    if (flags['no-summarize'] !== true) {
      tasks.push(summarizePending({ limit, force }).catch((e) => errorLog(`summarize falhou: ${e.message}`)));
    }
    if (flags['no-classify'] !== true) {
      tasks.push(classifyPending({ limit, force }).catch((e) => errorLog(`classify falhou: ${e.message}`)));
    }
    return Promise.all(tasks);
  });
  printStatus();
}

// reclean: re-limpa os 'suspect' com o passe FORTE (Pro) e re-verifica (melhoria da seção 7).
export async function cmdReclean(flags) {
  if (!HAS_LLM) {
    errorLog('OPENROUTER_API_KEY ausente — o reclean requer o caminho LLM.');
    process.exit(1);
  }
  const limit = flags.limit ? Number(flags.limit) : Infinity;
  await runWithLimits({ command: 'reclean', flags, profile: 'llm-only' }, () =>
    recleanSuspects({ limit }));
  printStatus();
}

// Acha UMA fonte por nome/URL/substring (mesmo espírito do --only do crawl). Erro se 0 ou 2+.
function findOneSource(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return { error: 'informe o nome/URL (ou parte) da fonte' };
  const all = stmts.listSources.all();
  const hits = all.filter((s) => `${s.name || ''} ${s.base_url}`.toLowerCase().includes(q));
  if (hits.length === 1) return { source: hits[0] };
  if (hits.length === 0) {
    return { error: `nenhuma fonte casa com "${query}". Fontes: ${all.map((s) => s.name || s.base_url).join(' | ') || '(nenhuma)'}` };
  }
  return { error: `"${query}" é ambíguo: ${hits.map((s) => s.name || s.base_url).join(' | ')}` };
}

// Apaga os DADOS de uma fonte (artigos+tags/classificações via cascade, pages, frontier,
// events; a fonte continua cadastrada) p/ refazer o processo do zero de forma reprodutível.
// `--selectors` também derruba o cache de seletores dos hosts da fonte.
export function cmdPurge(rest, flags) {
  const { source, error } = findOneSource(rest[0]);
  if (error) {
    errorLog(`purge: ${error}`);
    process.exit(1);
  }
  const nArticles = stmts.countArticlesBySource.get(source.id).c;
  if (flags.yes !== true) {
    errorLog(
      `purge APAGA os dados de "${source.name || source.base_url}" (id ${source.id}): ` +
        `${nArticles} artigo(s) + tags/classificações, pages, frontier e events.`,
    );
    errorLog(`Confirme com:  ncrawl purge ${JSON.stringify(rest[0])} --yes${flags.selectors ? ' --selectors' : ''}`);
    process.exit(1);
  }
  const counts = {
    articles: stmts.deleteArticlesBySource.run(source.id).changes,
    pages: stmts.deletePagesBySource.run(source.id).changes,
    frontier: stmts.deleteFrontierBySource.run(source.id).changes,
    events: stmts.deleteEventsBySource.run(source.id).changes,
  };
  if (flags.selectors === true) {
    const host = hostOf(source.base_url);
    counts.selectors = host ? stmts.deleteSelectorsLike.run(`${host}:%`).changes : 0;
  }
  log(
    `purge de "${source.name || source.base_url}": ` +
      Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(' ') +
      ' apagados (a fonte segue cadastrada — o próximo crawl refaz tudo).',
  );
  printStatus();
}

// ---------------- inspect: auditoria de uma run (o "ver tudo" pedido) ----------------
const parseDetail = (s) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

/** Relatório estruturado de uma run (dado puro; o cmdInspect imprime). */
export function getRunReport(runId) {
  const run = stmts.getRunById.get(runId);
  if (!run) return null;
  const articles = stmts.listArticlesForRunInspect.all(runId);
  const byIssue = new Map();
  for (const a of articles) {
    const key = a.issue_url || '(avulsos — fora de curadoria)';
    if (!byIssue.has(key)) byIssue.set(key, []);
    byIssue.get(key).push(a);
  }
  return {
    run,
    kinds: stmts.countArticlesByKindForRun.all(runId),
    verify: stmts.countVerifyForRun.all(runId),
    stages: stmts.countEventsByStage.all(runId),
    usage: stmts.usageByStage.all(runId),
    byIssue,
    events: stmts.listEventsForRun.all(runId),
  };
}

export function cmdInspect(flags) {
  // --url <substr>: linha do tempo de eventos + registros que casam (auditoria de UM link).
  if (typeof flags.url === 'string' && flags.url) {
    const like = `%${flags.url}%`;
    const arts = stmts.listArticlesLikeUrl.all(like);
    log(`— inspect --url "${flags.url}" —`);
    for (const a of arts) {
      log(
        `artigo #${a.id} [${a.kind || 'sem kind'}] ${a.verify_status || 'não verificado'}` +
          `${a.needs_enrich ? ' (aguardando corpo)' : ''} src=${a.content_source || '—'} ${a.title}`,
      );
      log(`  ${a.url}`);
      if (a.verify_notes) log(`  notas: ${a.verify_notes}`);
    }
    if (!arts.length) log('nenhum artigo casa.');
    const evs = stmts.listEventsForUrl.all(like, flags.verbose === true ? 500 : 100);
    for (const e of evs) {
      const d = parseDetail(e.detail);
      log(`[run ${e.run_id ?? '—'}] ${e.created_at} ${e.stage}/${e.status}${d ? ` ${JSON.stringify(d)}` : ''}  ${e.url}`);
    }
    if (!evs.length) log('nenhum evento casa.');
    return;
  }

  // Run alvo: --run N | default = última run DE CRAWL (verify/classify avulsos não têm artigos).
  const latest = stmts.getLatestCrawlRunId.get().id ?? stmts.getLatestRunId.get().id;
  const runId = flags.run ? Number(flags.run) : latest;
  if (!runId) {
    errorLog('inspect: nenhuma run registrada ainda (rode um crawl).');
    process.exit(1);
  }
  const rep = getRunReport(runId);
  if (!rep) {
    errorLog(`inspect: run #${runId} não existe. Runs recentes: ${stmts.listRuns.all(5).map((r) => `#${r.id} ${r.command}`).join(', ') || '—'}`);
    process.exit(1);
  }
  const { run } = rep;
  log(`— inspect run #${run.id} (${run.command || '—'}, ${run.status}, início ${run.started_at}) —`);
  log(`custo LLM: US$ ${Number(run.spent_usd).toFixed(4)}${run.budget_usd ? ` de US$ ${Number(run.budget_usd).toFixed(2)}` : ''}`);
  if (rep.usage.length) {
    log(`  por etapa: ${rep.usage.map((u) => `${u.stage}=${u.n}x/US$${u.usd.toFixed(4)}`).join(' ')}`);
  }
  log(`artigos da run: ${[...rep.byIssue.values()].reduce((n, a) => n + a.length, 0)} — ${rep.kinds.map((k) => `${k.kind}=${k.c}`).join(' ') || '—'}`);
  log(`verificação: ${rep.verify.map((v) => `${v.s}=${v.c}`).join(' ') || '—'}`);
  if (rep.stages.length) {
    log(`eventos: ${rep.stages.map((s) => `${s.stage}/${s.status}=${s.c}`).join(' ')}`);
  }

  for (const [issue, arts] of rep.byIssue) {
    log('');
    log(`ISSUE ${issue} — ${arts.length} registro(s)`);
    for (const a of arts) {
      const v = a.verify_status || 'pend';
      const srcTag = a.needs_enrich ? 'blurb (aguardando corpo)' : a.content_source === 'aggregator' ? 'blurb do agregador' : `alvo${a.cleaned ? '+limpo' : ''}`;
      log(`  [${(a.kind || '—').padEnd(7)}] ${v.padEnd(7)} ${String(a.content_len).padStart(6)}ch ${srcTag.padEnd(24)} ${(a.title || a.url).slice(0, 76)}`);
      if (flags.verbose === true && a.verify_notes) log(`      ⚠ ${a.verify_notes}`);
    }
  }

  // Itens que a curadoria deixou de fora + jobs falhos: o "porquê" de cada ausência.
  const skips = rep.events.filter((e) => (e.stage === 'item' && e.status === 'skipped') || (e.stage === 'article' && e.status === 'skip'));
  if (skips.length) {
    log('');
    log('fora do cadastro (com motivo):');
    for (const e of skips) {
      const d = parseDetail(e.detail) || {};
      log(`  ${e.stage === 'item' ? `curadoria: ${d.count ?? 1}x ${d.kind}` : `artigo: ${d.reason}`} — ${(d.issue || e.url || '').slice(0, 70)}`);
    }
  }
  const failed = stmts.countFrontierByState.all().find((r) => r.state === 'failed');
  if (failed?.c) log(`frontier: ${failed.c} job(s) em estado failed (use --url p/ investigar um link)`);
  if (flags.verbose !== true) log('dica: --verbose mostra as notas de verificação; --url <substr> audita um link.');
}

// Busca na base. Modo A (Flash, varre tudo) ou B (Pro, por tags). RETORNA os resultados (a UI captura).
export async function cmdSearch(rest, flags) {
  if (!HAS_LLM) {
    errorLog('OPENROUTER_API_KEY ausente — a busca requer o caminho LLM.');
    process.exit(1);
  }
  const query = (rest || []).join(' ').trim(); // multiword sem aspas
  if (!query) {
    errorLog('uso: search <consulta> [--mode A|B] [--limit N] [--yes]');
    process.exit(1);
  }
  const mode = String(flags.mode || 'A').toUpperCase() === 'B' ? 'B' : 'A';
  const limit = flags.limit ? Number(flags.limit) : Infinity;
  // Delta: por padrão busca só na última execução; --all (ou sem runs) busca no acervo inteiro.
  // O MESMO escopo alimenta o guard e o motor (runSearch) — guard e varredura nunca divergem.
  const scope = getSearchScope(flags);
  if (mode === 'A') {
    // Guard de custo: o modo A faz 1 chamada Flash por artigo (estima contra o escopo real).
    const n = Math.min(scope.count, Number.isFinite(limit) ? limit : Infinity);
    if (n > SEARCH_MODE_A_CONFIRM && flags.yes !== true) {
      errorLog(
        `Modo A vai avaliar ~${n} artigos (custo alto). Refaça com --yes, ou use --limit N / --mode B / --all.`,
      );
      process.exit(1);
    }
  }
  return runWithLimits({ command: 'search', flags, profile: 'llm-only' }, () =>
    runSearch(query, {
      mode, limit, yes: flags.yes === true, all: scope.all, runId: scope.runId,
      origin: flags.origin === 'tui' ? 'tui' : 'cli', // a TUI marca a origem p/ o histórico
    }));
}

// ---- histórico de buscas (tabela `searches`): lido pela TUI e pela web UI local ----

/** Lista o histórico (novo→antigo) com stats/escopo já parseados e custo real (llm_usage). */
export function listSearchHistory() {
  return stmts.listSearches.all().map((s) => ({
    id: s.id,
    created_at: s.created_at,
    origin: s.origin,
    query: s.query,
    mode: s.mode,
    scope: parseDetail(s.scope_json) || {},
    stats: parseDetail(s.stats_json) || {},
    spent_usd: s.spent_usd || 0,
  }));
}

/**
 * Reabre uma busca salva SEM LLM: re-hidrata os hits congelados (ids+vereditos) do acervo e
 * remonta os buckets no MESMO shape do retorno de runSearch (a ResultsView da TUI consome
 * direto). Ids que sumiram do acervo (purge) viram `missing` — aviso, nunca erro.
 */
export function getSearchHistoryEntry(id) {
  const s = stmts.getSearch.get(id);
  if (!s) return null;
  const hits = parseDetail(s.hits_json) || [];
  const rows = hits.length
    ? stmts.searchArticlesByIds.all({ ids: JSON.stringify(hits.map((h) => h.id)) })
    : [];
  const byId = new Map(rows.map((a) => [a.id, a]));
  const snippet = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const buckets = { noticias: [], ferramentas: [] };
  let missing = 0;
  for (const h of hits) {
    const a = byId.get(h.id);
    if (!a) {
      missing++;
      continue;
    }
    const item = {
      id: a.id, url: a.url, title: a.title, title_pt: a.title_pt, summary_pt: a.summary_pt,
      snippet: snippet(a.content), source_name: a.source_name || null, date_iso: a.date_iso || null,
      relation: h.relation, score: h.score ?? h.relation, kind: h.kind ?? undefined,
    };
    (h.bucket === 'ferramentas' || (!h.bucket && h.kind === 'tool') ? buckets.ferramentas : buckets.noticias)
      .push(item);
  }
  const stats = parseDetail(s.stats_json) || {};
  return {
    historyId: s.id,
    created_at: s.created_at,
    origin: s.origin,
    spent_usd: s.spent_usd || 0,
    scope: parseDetail(s.scope_json) || {},
    missing,
    query: s.query,
    mode: s.mode,
    scanned: stats.scanned ?? null,
    total: stats.total ?? null,
    relevant: (buckets.noticias.length + buckets.ferramentas.length),
    skipped: stats.skipped || 0,
    buckets,
  };
}

/** Apaga uma busca do histórico (ou todas, sem id). Retorna quantas linhas saíram. */
export function deleteSearchHistory(id = null) {
  const info = id == null ? stmts.clearSearches.run() : stmts.deleteSearch.run(id);
  return info.changes;
}

// Limites de execução (orçamento/paralelismo/RAM). `limits set` persiste em NC_HOME/.env (mesmo
// arquivo e helper do `key set`); `limits show` (default) mostra os efetivos + origem + gasto.
export function cmdLimits(rest, flags) {
  const sub = String(rest[0] || '').toLowerCase();

  if (sub === 'set') {
    let n = 0;
    if (flags.budget != null) {
      const v = Number(flags.budget);
      if (!Number.isFinite(v) || v < 0) {
        errorLog(`--budget inválido (USD >= 0, 0 = ilimitado): ${flags.budget}`);
        process.exit(1);
      }
      upsertEnvVar('BUDGET_USD', String(v));
      n++;
    }
    if (flags.parallel != null) {
      const v = Number(flags.parallel);
      if (!Number.isInteger(v) || v < 0) {
        errorLog(`--parallel inválido (inteiro >= 1, ou 0 = auto pelos núcleos): ${flags.parallel}`);
        process.exit(1);
      }
      upsertEnvVar('MAX_PARALLEL', String(v));
      n++;
    }
    if (flags['ram-max-pct'] != null) {
      const v = Number(flags['ram-max-pct']);
      if (!Number.isFinite(v) || v < 10 || v > 95) {
        errorLog(`--ram-max-pct inválido (10..95): ${flags['ram-max-pct']}`);
        process.exit(1);
      }
      upsertEnvVar('RAM_MAX_PCT', String(v));
      n++;
    }
    if (!n) {
      errorLog('uso: ncrawl limits set [--budget USD] [--parallel N] [--ram-max-pct P]');
      process.exit(1);
    }
    log(`limites salvos em ${ENV_PATH} (valem p/ os próximos runs; flags por-run têm precedência)`);
    return;
  }

  // show (default): valor efetivo + origem (env = setado no .env/shell; auto = derivado).
  const origem = (k) => (process.env[k] != null && process.env[k] !== '' ? 'env' : 'auto');
  const N = MAX_PARALLEL;
  log('— limites —');
  log(`parallel:    ${N} (${origem('MAX_PARALLEL')}; auto = núcleos clamp 4..64 = ${defaultParallel()})`);
  log(`budget:      ${BUDGET_USD > 0 ? `US$ ${BUDGET_USD.toFixed(2)}/run` : 'ilimitado'} (${origem('BUDGET_USD')})`);
  log(`ram-max-pct: ${RAM_MAX_PCT}% (${origem('RAM_MAX_PCT')})`);
  log(
    `lanes (perfil crawl):    llm=${Math.ceil(N * 0.6)} fetch=${Math.ceil(N / 4)} render<=${Math.ceil(N / 4)} (RAM manda)`,
  );
  log(`lanes (perfil llm-only): llm=${N}`);
  try {
    const t = stmts.sumUsageTotal.get();
    log(`gasto all-time: US$ ${t.usd.toFixed(4)} em ${t.n} chamadas LLM`);
    const runs = stmts.listRuns.all(10);
    if (runs.length) {
      log('últimos runs:');
      for (const r of runs) {
        const cap = r.budget_usd != null ? `/${Number(r.budget_usd).toFixed(2)}` : '';
        log(`  #${r.id} ${r.command} — US$ ${Number(r.spent_usd).toFixed(4)}${cap} (${r.status}, ${r.started_at})`);
      }
    }
  } catch {
    /* ledger vazio/DB antigo: os limites acima já foram mostrados */
  }
  log('uso: ncrawl limits set [--budget USD] [--parallel N] [--ram-max-pct P]');
}

// Sobe o buscador web local (React zero-build, filtros sobre a base) e fica no ar até
// SIGINT/SIGTERM. A TUI NÃO passa por aqui: chama startWebServer direto p/ ser dona do
// ciclo de vida (parar por tecla, sem sinal).
export async function cmdWeb(flags) {
  let port; // undefined = WEB_PORT (config)
  if (flags.port !== undefined) {
    port = Number(flags.port);
    if (flags.port === true || !Number.isInteger(port) || port < 0 || port > 65535) {
      errorLog(`--port inválido: ${flags.port} (use 0–65535; 0 = porta efêmera)`);
      process.exit(1);
    }
  }
  const srv = await startWebServer({ port, open: flags['no-open'] !== true });
  log('Ctrl+C encerra o buscador.');
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  log('encerrando o buscador web…');
  await srv.close();
}

// Gerência da chave OpenRouter. `key set <chave>` valida (probe) e grava em NC_HOME/.env; `key test`
// valida a chave atual. Sem subcomando: mostra o estado. A validação impede salvar uma chave ruim.
export async function cmdKey(rest, flags) {
  // `rest` já vem SEM o "key" (index.js faz rest.shift()): rest[0]=subcomando, rest[1]=chave.
  const sub = String(rest[0] || '').toLowerCase();

  if (sub === 'set') {
    const key = rest[1] || (typeof flags.key === 'string' ? flags.key : '');
    if (!key) {
      errorLog('uso: ncrawl key set <OPENROUTER_API_KEY>');
      process.exit(1);
    }
    log('validando a chave na OpenRouter (GET /api/v1/key)…');
    const r = await probeOpenRouterKey(key);
    if (!r.ok) {
      errorLog(
        `chave INVÁLIDA (HTTP ${r.status || '—'}${r.reason ? `: ${r.reason}` : ''}) — nada foi salvo.`,
      );
      process.exit(1);
    }
    const { updated, file } = upsertEnvVar('OPENROUTER_API_KEY', key);
    setRuntimeKey(key); // vale JÁ neste processo (a TUI encadeia comandos sem reiniciar)
    log(`chave válida ✓ ${maskKey(key)} — ${updated ? 'atualizada' : 'salva'} em ${file}`);
    return;
  }

  if (sub === 'test') {
    if (!OPENROUTER_API_KEY) {
      errorLog(`nenhuma chave configurada. Rode: ncrawl key set <chave>  (será salva em ${ENV_PATH})`);
      process.exit(1);
    }
    log(`testando a chave atual ${maskKey(OPENROUTER_API_KEY)}…`);
    const r = await probeOpenRouterKey(OPENROUTER_API_KEY);
    if (!r.ok) {
      errorLog(`chave INVÁLIDA (HTTP ${r.status || '—'}). Rode: ncrawl key set <chave>`);
      process.exit(1);
    }
    log('chave válida ✓ (HTTP 200)');
    return;
  }

  // Sem subcomando: estado atual + uso (não é erro).
  if (OPENROUTER_API_KEY) log(`chave configurada: ${maskKey(OPENROUTER_API_KEY)} — arquivo previsível: ${ENV_PATH}`);
  else log(`nenhuma chave configurada ainda — arquivo previsível: ${ENV_PATH}`);
  log('uso: ncrawl key set <chave>   valida na OpenRouter e salva');
  log('     ncrawl key test          valida a chave atual');
}
