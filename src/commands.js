// Implementação dos comandos (sem efeito colateral ao importar) — compartilhada entre a CLI
// (src/index.js) e a UI (src/ui/). Os comandos logam por util log/warn/errorLog, então a UI
// captura tudo via setLogSink. As contagens vêm de getStatus() (dado), reusado pela UI.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stmts, wipeAll } from './db.js';
import {
  EXPORT_DIR, DB_PATH, CONCURRENCY, MAX_RETRIES, HAS_LLM, CLASSIFY_AFTER_CRAWL, SUMMARIZE_AFTER_CRAWL,
  SEARCH_MODE_A_CONFIRM, OPENROUTER_API_KEY, ENV_PATH, BUDGET_USD, MAX_PARALLEL, RAM_MAX_PCT,
  defaultParallel, loadSources, addSourceToConfig,
} from './config.js';
import {
  initGovernor, stopGovernor, setProfile, jobsCapacity, getTelemetry,
} from './governor.js';
import { beginRun, endRun, shouldStop, getBudgetState } from './budget.js';
import { processJob, enqueue, upsertSource } from './crawl.js';
import { classifyPending } from './classify.js';
import { summarizePending } from './summarize.js';
import { runSearch, getSearchProgress } from './search.js';
import { closeBrowser } from './fetch.js';
import { startWebServer } from './web.js';
import { probeOpenRouterKey, upsertEnvVar, maskKey } from './keys.js';
import { slugify, normalizeUrl, parseDate, log, errorLog } from './util.js';

// Re-export p/ a UI importar de um lugar só (igual getStatus).
export { getSearchProgress };

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
    if (enqueue(s.url, 'listing', null, src.id, 0)) log(`seed: ${s.url} (type=${src.type})`);
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

  const opts = {
    maxPages: flags['max-pages'] ? Number(flags['max-pages']) : Infinity,
    sinceDate,
  };
  const maxArticles = flags['max-articles'] ? Number(flags['max-articles']) : Infinity;

  // Capacidade DINÂMICA do loop: o governador redimensiona as lanes fetch+render pela RAM;
  // env CONCURRENCY > 0 vira teto duro por cima. Sem gate p-limit: o próprio loop é o gate
  // (as lanes de fetch/render dentro do job limitam o trabalho pesado).
  const capacity = () =>
    CONCURRENCY > 0 ? Math.min(CONCURRENCY, jobsCapacity()) : jobsCapacity();
  const inflight = new Set();
  let processedArticles = 0;
  let budgetRequeued = 0;

  const dispatch = (job) => {
    const p = (async () => {
      try {
        await processJob(job, opts);
        if (job.kind === 'article') processedArticles++;
        stmts.finish.run('done', job.url);
      } catch (e) {
        if (e?.code === 'BUDGET_EXCEEDED') {
          // Orçamento: devolve à fila SEM consumir retry — retomável no próximo run. O loop
          // já parou de reivindicar (shouldStop), então não há hot-loop aqui.
          stmts.finish.run('pending', job.url);
          budgetRequeued++;
          return;
        }
        const r = stmts.getRetries.get(job.url);
        if ((r?.retries ?? 0) < MAX_RETRIES) stmts.bumpRetry.run(job.url);
        else stmts.finish.run('failed', job.url);
        errorLog(`job falhou (${job.kind} ${job.url}): ${e.message}`);
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
    if (inflight.size === 0) break; // nada rodando e nada a reivindicar => fim
    await Promise.race(inflight);
  }
  await Promise.allSettled(inflight);
  await closeBrowser();
  if (budgetRequeued) log(`orçamento: ${budgetRequeued} jobs devolvidos à fila (retomáveis no próximo run)`);
  log('crawl concluído.');

  // Hooks pós-crawl EM PARALELO (classify e summarize são independentes — ambos só leem
  // articles e escrevem tabelas próprias); o perfil llm-only dá o teto todo à lane llm.
  const post = [];
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
    log('orçamento atingido: classify/summarize pulados — retome com `ncrawl classify` / `ncrawl summarize`');
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
  let n = 0;
  for (const s of stmts.listSources.all()) {
    const arts = stmts.listArticlesBySource.all(s.id);
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
  log(`exportados ${n} artigos para ${outDir} (${format})`);
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
  if (mode === 'A') {
    // Guard de custo: o modo A faz 1 chamada Flash por artigo.
    const total = stmts.countArticles.get().c;
    const n = Math.min(total, Number.isFinite(limit) ? limit : Infinity);
    if (n > SEARCH_MODE_A_CONFIRM && flags.yes !== true) {
      errorLog(
        `Modo A vai avaliar ~${n} artigos (custo alto). Refaça com --yes, ou use --limit N / --mode B.`,
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
