#!/usr/bin/env node
// CLI: crawl | status | add | export. Loop principal resumível com concorrência.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { stmts, db } from './db.js';
import { ROOT, CONCURRENCY, MAX_RETRIES, HAS_LLM, CLASSIFY_AFTER_CRAWL, loadSources } from './config.js';
import { processJob, enqueue, upsertSource } from './crawl.js';
import { classifyPending } from './classify.js';
import { closeBrowser } from './fetch.js';
import { slugify, log, errorLog } from './util.js';

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

function printStatus() {
  const counts = Object.fromEntries(stmts.countFrontierByState.all().map((r) => [r.state, r.c]));
  const articles = stmts.countArticles.get().c;
  const classified = stmts.countClassifications.get().c;
  log('— status —');
  log(`sources:   ${stmts.countSources.get().c}`);
  log(`pages:     ${stmts.countPages.get().c}`);
  log(`articles:  ${articles}`);
  log(`selectors: ${stmts.countSelectors.get().c}`);
  log(`classif.:  done=${classified} pending=${Math.max(0, articles - classified)}`);
  log(
    `frontier:  pending=${counts.pending || 0} in_progress=${counts.in_progress || 0} ` +
      `done=${counts.done || 0} failed=${counts.failed || 0}`,
  );
}

async function cmdCrawl(flags) {
  if (!HAS_LLM) {
    log('AVISO: OPENROUTER_API_KEY ausente — só o caminho estático/cache roda; sem derivação de seletor.');
  }

  // Resume: jobs que ficaram travados voltam para a fila.
  const reset = stmts.resetInProgress.run();
  if (reset.changes) log(`resume: ${reset.changes} jobs in_progress -> pending`);

  // Semeia as fontes do config. `--only <substr>` semeia só as fontes cujo nome/url casam
  // (útil p/ debugar uma newsletter isolada).
  const only = typeof flags.only === 'string' ? flags.only.toLowerCase() : null;
  for (const s of loadSources()) {
    if (only && !`${s.name || ''} ${s.url}`.toLowerCase().includes(only)) continue;
    const src = upsertSource(s);
    if (enqueue(s.url, 'listing', null, src.id, 0)) log(`seed: ${s.url} (type=${src.type})`);
  }

  const opts = { maxPages: flags['max-pages'] ? Number(flags['max-pages']) : Infinity };
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

  printStatus();
}

function cmdAdd(rest, flags) {
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
    `\n${a.content || ''}\n`
  );
}

function cmdExport(flags) {
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

async function cmdClassify(flags) {
  if (!HAS_LLM) {
    errorLog('OPENROUTER_API_KEY ausente — a classificação requer o caminho LLM.');
    process.exit(1);
  }
  const limit = flags.limit ? Number(flags.limit) : Infinity;
  const force = flags.force === true;
  await classifyPending({ limit, force });
  printStatus();
}

// ---------------- entrypoint ----------------
const { flags, rest } = parseFlags(process.argv.slice(2));
const cmd = rest.shift() || 'crawl';

try {
  if (cmd === 'crawl') await cmdCrawl(flags);
  else if (cmd === 'status') printStatus();
  else if (cmd === 'add') cmdAdd(rest, flags);
  else if (cmd === 'export') cmdExport(flags);
  else if (cmd === 'classify') await cmdClassify(flags);
  else {
    errorLog(`comando desconhecido: ${cmd} (use: crawl | status | add | export | classify)`);
    process.exit(1);
  }
  db.close();
} catch (e) {
  errorLog(e.stack || e.message);
  await closeBrowser();
  process.exit(1);
}
