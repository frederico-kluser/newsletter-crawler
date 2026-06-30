// Implementação dos comandos (sem efeito colateral ao importar) — compartilhada entre a CLI
// (src/index.js) e a UI (src/ui/). Os comandos logam por util log/warn/errorLog, então a UI
// captura tudo via setLogSink. As contagens vêm de getStatus() (dado), reusado pela UI.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { stmts, wipeAll } from './db.js';
import {
  ROOT, DB_PATH, CONCURRENCY, MAX_RETRIES, HAS_LLM, CLASSIFY_AFTER_CRAWL, SUMMARIZE_AFTER_CRAWL,
  SEARCH_MODE_A_CONFIRM, loadSources,
} from './config.js';
import { processJob, enqueue, upsertSource } from './crawl.js';
import { classifyPending } from './classify.js';
import { summarizePending } from './summarize.js';
import { runSearch, getSearchProgress } from './search.js';
import { closeBrowser } from './fetch.js';
import { slugify, normalizeUrl, parseDate, log, errorLog } from './util.js';

// Re-export p/ a UI importar de um lugar só (igual getStatus).
export { getSearchProgress };

/** Contagens do banco como DADO (reusado pela UI e pelo printStatus). */
export function getStatus() {
  const f = Object.fromEntries(stmts.countFrontierByState.all().map((r) => [r.state, r.c]));
  const articles = stmts.countArticles.get().c;
  const classified = stmts.countClassifications.get().c;
  const summaries = stmts.countSummaries.get().c;
  return {
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
  log(
    `frontier:  pending=${s.frontier.pending} in_progress=${s.frontier.in_progress} ` +
      `done=${s.frontier.done} failed=${s.frontier.failed}`,
  );
}

export async function cmdCrawl(flags) {
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

  const limit = pLimit(CONCURRENCY);
  const inflight = new Set();
  let processedArticles = 0;

  const dispatch = (job) => {
    const p = limit(async () => {
      try {
        await processJob(job, opts);
        if (job.kind === 'article') processedArticles++;
        stmts.finish.run('done', job.url);
      } catch (e) {
        const r = stmts.getRetries.get(job.url);
        if ((r?.retries ?? 0) < MAX_RETRIES) stmts.bumpRetry.run(job.url);
        else stmts.finish.run('failed', job.url);
        errorLog(`job falhou (${job.kind} ${job.url}): ${e.message}`);
      }
    }).finally(() => inflight.delete(p));
    inflight.add(p);
  };

  for (;;) {
    while (processedArticles < maxArticles && inflight.size < CONCURRENCY) {
      const job = stmts.claimNext.get();
      if (!job) break;
      dispatch(job);
    }
    if (inflight.size === 0) break; // nada rodando e nada a reivindicar => fim
    await Promise.race(inflight);
  }
  await Promise.allSettled(inflight);
  await closeBrowser();
  log('crawl concluído.');

  // Hook pós-crawl: classifica os novos artigos (configurável). `--no-classify` pula esta execução.
  if (CLASSIFY_AFTER_CRAWL && HAS_LLM && flags['no-classify'] !== true) {
    try {
      await classifyPending({});
    } catch (e) {
      errorLog(`classify pós-crawl falhou: ${e.message}`);
    }
  }

  // Hook pós-crawl: gera os resumos PT-BR (configurável). `--no-summarize` pula.
  if (SUMMARIZE_AFTER_CRAWL && HAS_LLM && flags['no-summarize'] !== true) {
    try {
      await summarizePending({});
    } catch (e) {
      errorLog(`summarize pós-crawl falhou: ${e.message}`);
    }
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
  log(`fonte adicionada: ${src.base_url} (id ${src.id}, type=${src.type})`);
}

// Limpa TODOS os dados (slate limpo). Destrutivo: exige --yes.
export function cmdReset(flags) {
  if (flags.yes !== true) {
    errorLog(
      `reset APAGA TODOS OS DADOS de ${DB_PATH} (articles, frontier, pages, selectors, ` +
        'classifications, article_tags, classification_uncovered, sources).',
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
  const outDir = path.join(ROOT, 'data', 'export');
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
  await classifyPending({ limit, force });
  printStatus();
}

export async function cmdSummarize(flags) {
  if (!HAS_LLM) {
    errorLog('OPENROUTER_API_KEY ausente — o resumo PT-BR requer o caminho LLM.');
    process.exit(1);
  }
  const limit = flags.limit ? Number(flags.limit) : Infinity;
  const force = flags.force === true;
  await summarizePending({ limit, force });
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
  return runSearch(query, { mode, limit, yes: flags.yes === true });
}
