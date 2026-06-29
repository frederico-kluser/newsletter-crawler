#!/usr/bin/env node
// CLI: crawl | status | add | export. Loop principal resumível com concorrência.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { stmts, db } from './db.js';
import { ROOT, CONCURRENCY, MAX_RETRIES, HAS_LLM, loadSources } from './config.js';
import { processJob, enqueue, upsertSource } from './crawl.js';
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
  log('— status —');
  log(`sources:   ${stmts.countSources.get().c}`);
  log(`pages:     ${stmts.countPages.get().c}`);
  log(`articles:  ${stmts.countArticles.get().c}`);
  log(`selectors: ${stmts.countSelectors.get().c}`);
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

  // Semeia as fontes do config.
  for (const s of loadSources()) {
    const src = upsertSource(s);
    if (enqueue(s.url, 'listing', null, src.id)) log(`seed: ${s.url}`);
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
  printStatus();
}

function cmdAdd(rest, flags) {
  const url = rest[0];
  if (!url) {
    errorLog('uso: add <url> [--name "Nome"]');
    process.exit(1);
  }
  const src = upsertSource({ url, name: typeof flags.name === 'string' ? flags.name : undefined });
  enqueue(url, 'listing', null, src.id);
  log(`fonte adicionada: ${src.base_url} (id ${src.id})`);
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
      if (format === 'json') {
        writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(a, null, 2));
      } else {
        const md =
          `# ${a.title || ''}\n\n` +
          `> ${a.url}\n` +
          (a.published_at ? `> ${a.published_at}\n` : '') +
          `\n${a.content || ''}\n`;
        writeFileSync(path.join(dir, `${base}.md`), md);
      }
      n++;
    }
  }
  log(`exportados ${n} artigos para ${outDir} (${format})`);
}

// ---------------- entrypoint ----------------
const { flags, rest } = parseFlags(process.argv.slice(2));
const cmd = rest.shift() || 'crawl';

try {
  if (cmd === 'crawl') await cmdCrawl(flags);
  else if (cmd === 'status') printStatus();
  else if (cmd === 'add') cmdAdd(rest, flags);
  else if (cmd === 'export') cmdExport(flags);
  else {
    errorLog(`comando desconhecido: ${cmd} (use: crawl | status | add | export)`);
    process.exit(1);
  }
  db.close();
} catch (e) {
  errorLog(e.stack || e.message);
  await closeBrowser();
  process.exit(1);
}
