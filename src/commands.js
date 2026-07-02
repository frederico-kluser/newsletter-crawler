// Implementação dos comandos (sem efeito colateral ao importar) — compartilhada entre a CLI
// (src/index.js) e a UI (src/ui/). Os comandos logam por util log/warn/errorLog, então a UI
// captura tudo via setLogSink. As contagens vêm de getStatus() (dado), reusado pela UI.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stmts, wipeAll } from './db.js';
import {
  EXPORT_DIR, DB_PATH, CONCURRENCY, MAX_RETRIES, HAS_LLM, CLASSIFY_AFTER_CRAWL, SUMMARIZE_AFTER_CRAWL,
  SEARCH_MODE_A_CONFIRM, OPENROUTER_API_KEY, ENV_PATH, BUDGET_USD, MAX_PARALLEL, RAM_MAX_PCT,
  AGGRESSIVE_DEFAULT, VERIFY_AFTER_CRAWL, VERIFY_STREAMING, JOB_TIMEOUT_MS,
  defaultParallel, loadSources, addSourceToConfig,
} from './config.js';
import {
  initGovernor, stopGovernor, setProfile, jobsCapacity, getTelemetry,
} from './governor.js';
import { beginRun, endRun, shouldStop, getBudgetState } from './budget.js';
import { processJob, enqueue, upsertSource } from './crawl.js';
import { classifyPending } from './classify.js';
import { summarizePending } from './summarize.js';
import { verifyPending, verifyArticleRow } from './verify.js';
import { runSearch, getSearchProgress } from './search.js';
import { closeBrowser } from './fetch.js';
import { closeParsePool } from './parse-pool.js';
import { logEvent, flushEvents } from './events.js';
import { startWebServer } from './web.js';
import { probeOpenRouterKey, upsertEnvVar, maskKey } from './keys.js';
import { slugify, normalizeUrl, parseDate, hostOf, log, warn, errorLog, debug } from './util.js';

// Re-export p/ a UI importar de um lugar só (igual getStatus).
export { getSearchProgress };

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

/** Telemetria viva (governador + orçamento) p/ o painel da UI pollar junto do getStatus. */
export function getRunTelemetry() {
  return { governor: getTelemetry(), budget: getBudgetState() };
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

  // Re-crawl incremental: por padrão re-visita as listagens das fontes a cada execução (só enfileira
  // o novo; a dedup de artigo impede re-baixar o existente). `--no-refresh` desliga a re-visita.
  const noRefresh = flags['no-refresh'] === true;

  // Seleção de fonte ao executar: `--source "<nome exato>"` (ou a URL) seleciona UMA fonte;
  // `--only <substr>` casa por substring no nome/url. Sem nenhum, semeia todas do config.
  const only = typeof flags.only === 'string' ? flags.only.toLowerCase() : null;
  const sourceExact = typeof flags.source === 'string' ? flags.source.toLowerCase() : null;
  for (const s of loadSources()) {
    if (only && !`${s.name || ''} ${s.url}`.toLowerCase().includes(only)) continue;
    if (
      sourceExact &&
      (s.name || '').toLowerCase() !== sourceExact &&
      normalizeUrl(s.url) !== normalizeUrl(flags.source)
    ) {
      continue;
    }
    const src = upsertSource(s);
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

  // --since <YYYY-MM-DD|ISO>: piso de data (coleta do mais novo até esse piso e para). Aplica
  // à data da issue E do artigo. Data inválida aborta (em vez de ignorar o filtro silenciosamente).
  const sinceRaw = typeof flags.since === 'string' ? flags.since : null;
  const sinceDate = sinceRaw ? parseDate(sinceRaw) : null;
  if (sinceRaw && !sinceDate) {
    errorLog(`--since inválido (use ISO, ex.: 2026-06-25): ${sinceRaw}`);
    process.exit(1);
  }
  if (sinceDate) log(`--since ativo: piso ${sinceDate.toISOString()}`);

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
  const inflight = new Set(); // jobs (limitados por fetch+render)
  const verifying = new Set(); // verificação em streaming (lane llm; NÃO conta na capacity)
  let processedArticles = 0;
  let budgetRequeued = 0;
  let timedOut = 0;

  // Verificação em STREAMING: logo após salvar/enriquecer uma ficha, verifica na folga da lane
  // llm (o sweep final segue como rede de segurança p/ os NULL restantes). Rastreada num set à
  // parte p/ o loop esperar por ela sem roubar capacidade de fetch/render.
  const streamVerify = (verifyUrl) => {
    if (!(VERIFY_STREAMING && HAS_LLM && verifyUrl) || shouldStop()) return;
    const p = (async () => {
      try {
        const a = stmts.getArticleFullByUrl.get(verifyUrl);
        if (!a || a.verify_status != null) return; // já verificada (ou sumiu): pula
        await verifyArticleRow(a, { runId });
      } catch (e) {
        if (e?.code !== 'BUDGET_EXCEEDED') debug(`verify streaming falhou (${verifyUrl}): ${e.message}`);
      }
    })().finally(() => verifying.delete(p));
    verifying.add(p);
  };

  const dispatch = (job) => {
    const p = (async () => {
      try {
        // Deadline SÓ p/ jobs de artigo (o "retardatário" é um fetch/enriquecimento lento). Jobs
        // de listing/roundup fazem trabalho de LLM legítimo e mais longo (curadoria por seções +
        // cobertura), já limitado por LLM_TIMEOUT_MS/orçamento — cortá-los abortaria a curadoria.
        const deadline = job.kind === 'article' ? JOB_TIMEOUT_MS : 0;
        const res = await withTimeout(processJob(job, opts), deadline);
        if (job.kind === 'article') processedArticles++;
        stmts.finish.run('done', job.url);
        if (res?.verifyUrl) streamVerify(res.verifyUrl); // salvou/enriqueceu -> verifica já
      } catch (e) {
        if (e?.code === 'BUDGET_EXCEEDED') {
          // Orçamento: devolve à fila SEM consumir retry — retomável no próximo run. O loop
          // já parou de reivindicar (shouldStop), então não há hot-loop aqui.
          stmts.finish.run('pending', job.url);
          budgetRequeued++;
          return;
        }
        if (e?.code === 'JOB_TIMEOUT') {
          timedOut++;
          logEvent({ runId, url: job.url, stage: 'job', status: 'timeout', detail: { ms: JOB_TIMEOUT_MS, kind: job.kind } });
          const row = job.kind === 'article' ? stmts.getArticleFullByUrl.get(normalizeUrl(job.url) || job.url) : null;
          if (row?.needs_enrich) {
            // A ficha JÁ existe com o blurb do agregador: encerra o job (não re-tenta agora, senão
            // trava de novo) e deixa needs_enrich=1 — o próximo crawl re-enfileira p/ enriquecer.
            stmts.finish.run('done', job.url);
            log(`job estourou ${JOB_TIMEOUT_MS}ms — ficha mantida com o blurb (enriquece depois): ${job.url.slice(0, 70)}`);
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
    })().finally(() => inflight.delete(p));
    inflight.add(p);
  };

  for (;;) {
    while (processedArticles < maxArticles && !shouldStop() && inflight.size < capacity()) {
      const job = stmts.claimNext.get();
      if (!job) break;
      dispatch(job);
    }
    if (inflight.size === 0 && verifying.size === 0) break; // nada rodando e nada a reivindicar => fim
    await Promise.race([...inflight, ...verifying]);
  }
  await Promise.allSettled([...inflight, ...verifying]);
  await closeBrowser();
  await closeParsePool(); // encerra os workers de parsing (o pós-crawl não parseia HTML)
  if (budgetRequeued) log(`orçamento: ${budgetRequeued} jobs devolvidos à fila (retomáveis no próximo run)`);
  if (timedOut) log(`deadline: ${timedOut} job(s) cortado(s) em ${JOB_TIMEOUT_MS}ms (ficha mantida com o blurb; enriquece no próximo crawl)`);
  log('crawl concluído.');

  // Registra na run quantos artigos novos ela descobriu (o delta desta execução).
  if (runId != null) {
    const newCount = stmts.countArticlesByRun.get(runId).c;
    stmts.finishDeltaRun.run(newCount, runId);
    log(`run ${runId}: ${newCount} novo(s) artigo(s) desde a última execução.`);
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
    await Promise.all(post);
  } else if (shouldStop()) {
    log('orçamento atingido: verify/classify/summarize pulados — retome com os comandos diretos');
  }

  printStatus();
}

export function cmdAdd(rest, flags) {
  const url = rest[0];
  if (!url) {
    errorLog('uso: add <url> [--name "Nome"] [--type index|listing] [--max-index-pages N]');
    process.exit(1);
  }
  const src = upsertSource({
    url,
    name: typeof flags.name === 'string' ? flags.name : undefined,
    type: typeof flags.type === 'string' ? flags.type : undefined,
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

export async function cmdClassify(flags) {
  if (!HAS_LLM) {
    errorLog('OPENROUTER_API_KEY ausente — a classificação requer o caminho LLM.');
    process.exit(1);
  }
  const limit = flags.limit ? Number(flags.limit) : Infinity;
  const force = flags.force === true;
  await runWithLimits({ command: 'classify', flags, profile: 'llm-only' }, () =>
    classifyPending({ limit, force }));
  printStatus();
}

export async function cmdSummarize(flags) {
  if (!HAS_LLM) {
    errorLog('OPENROUTER_API_KEY ausente — o resumo PT-BR requer o caminho LLM.');
    process.exit(1);
  }
  const limit = flags.limit ? Number(flags.limit) : Infinity;
  const force = flags.force === true;
  await runWithLimits({ command: 'summarize', flags, profile: 'llm-only' }, () =>
    summarizePending({ limit, force }));
  printStatus();
}

// Verificação pós-cadastro sob demanda (a automática roda no fim do crawl).
export async function cmdVerify(flags) {
  if (!HAS_LLM) {
    errorLog('OPENROUTER_API_KEY ausente — a verificação requer o caminho LLM.');
    process.exit(1);
  }
  const limit = flags.limit ? Number(flags.limit) : Infinity;
  const force = flags.force === true;
  await runWithLimits({ command: 'verify', flags, profile: 'llm-only' }, () =>
    verifyPending({ limit, force }));
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
  const latest = stmts.getLatestRunId.get().id;
  const all = flags.all === true || latest == null;
  if (mode === 'A') {
    // Guard de custo: o modo A faz 1 chamada Flash por artigo (estima contra o escopo real).
    const total = all ? stmts.countArticles.get().c : stmts.countArticlesByRun.get(latest).c;
    const n = Math.min(total, Number.isFinite(limit) ? limit : Infinity);
    if (n > SEARCH_MODE_A_CONFIRM && flags.yes !== true) {
      errorLog(
        `Modo A vai avaliar ~${n} artigos (custo alto). Refaça com --yes, ou use --limit N / --mode B / --all.`,
      );
      process.exit(1);
    }
  }
  return runWithLimits({ command: 'search', flags, profile: 'llm-only' }, () =>
    runSearch(query, { mode, limit, yes: flags.yes === true }));
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
    `lanes (perfil crawl):    llm=${Math.ceil(N / 2)} fetch=${Math.ceil(N / 4)} render<=${Math.ceil(N / 4)} (RAM manda)`,
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
