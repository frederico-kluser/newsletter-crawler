// Reatribui DATA + issue_url aos itens legados das fontes `index` (6 Cooperpress + TWIR) usando a
// página da ISSUE como âncora — a semântica oficial do projeto ("um item curado pertence à SEMANA
// da issue", `enrichAnchorDate`/`updateArticleDatesByIssue`). O exportador antigo perdeu o
// `issue_url` e a captura bulk de 2026-08-30 gravou a DATA DA CAPTURA no lugar da data real
// (medido: 4.417 artigos Golang Weekly em 2026-08-30) — este script corrige os dois.
//
// Como funciona (sem LLM, idempotente, resumível):
//   1. lista de issues por fonte a partir da LISTAGEM — pelo seletor CACHEADO da listagem (a
//      mesma cadeia link+data do crawler: `applyLinkSelectorWithDates`/`dateNearLink`) com
//      fallback por regex (`/issues/N` Cooperpress, `/blog/AAAA/MM/DD/...` TWIR — data no URL);
//   2. cada issue é baixada (janela de N fetches em paralelo; aplicação ORDEADA por data, então
//      a issue MAIS ANTIGA que menciona um link fica com ele): data = extractPublishedDate
//      (fallback: data do URL/listagem), itens = hrefs EXTERNOS da página;
//   3. cada link que existe em `articles` SEM issue_url ganha {issue_url, published_at} via
//      `stmts.setIssueAttribution` (só linhas `issue_url IS NULL` da MESMA fonte); os irmãos já
//      atribuídos são alinhados por `updateArticleDatesByIssue`.
//
// Estado em NC_HOME/reattribute-state.json (issues já processadas) — Ctrl+C e re-rodar continua.
// Script throwaway → console direto é permitido (following-code-style: escape hatch p/ scripts).
//
// Uso: node scripts/reattribute-dates.mjs [--source "Golang"] [--dry-run] [--max-issues N]
//          [--workers N] [--reset-state]
//      node scripts/reattribute-dates.mjs --target-dates [--date <prefixo>] [--source "Golang"] [--dry-run]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import got from 'got';
import * as cheerio from 'cheerio';

import { NC_HOME, AGGRESSIVE_DEFAULT } from '../src/config.js';
import { stmts, db } from '../src/db.js';
import { extractPublishedDate } from '../src/parse-core.js';
import { getCachedSelector, applyLinkSelectorWithDates } from '../src/selectors.js';
import { normalizeUrl, parseDate, hostOf, domainSig } from '../src/util.js';

// ---- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sourceFilter = flag('--source');
const dryRun = args.includes('--dry-run');
const maxIssues = flag('--max-issues') ? Number(flag('--max-issues')) : Infinity;
const workers = Math.max(1, Number(flag('--workers')) || 5);
const statePath = path.join(NC_HOME, 'reattribute-state.json');
if (args.includes('--reset-state') && existsSync(statePath)) {
  writeFileSync(statePath, JSON.stringify({ done: [] }));
  console.log('estado zerado.');
}

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const get = async (url) => {
  const r = await got(url, {
    timeout: { request: 30000 },
    retry: { limit: 2 },
    headers: AGGRESSIVE_DEFAULT ? { 'user-agent': UA, accept: 'text/html,*/*' } : {},
    https: { rejectUnauthorized: false }, // kedglobal e afins têm CN inválido (regra do projeto)
  });
  return r.body;
};

// ---- regras puras (testáveis) ----------------------------------------------

/** Um link de listagem é uma ISSUE? Cooperpress `/issues/N` · TWIR `/blog/AAAA/MM/DD/slug`. */
export function isIssueUrl(abs, listingUrl) {
  if (!abs || hostOf(abs) !== hostOf(listingUrl)) return false;
  const p = new URL(abs).pathname;
  return /\/issues\/\d+/i.test(p) || (/\/blog\//i.test(p) && /\/\d{4}\/\d{2}\/\d{2}\//.test(p));
}

/**
 * Issues de UMA listagem → [{url, date}]. 1º o seletor cacheado da listagem (pareamento
 * link+data do crawler), depois fallback por regex (data do URL quando existe).
 */
export function extractIssueLinks(html, listingUrl, cachedSelector = null) {
  if (cachedSelector?.link_selector) {
    const dateSpec =
      cachedSelector.date_selector || cachedSelector.date_regex
        ? {
            date_selector: cachedSelector.date_selector || null,
            date_attribute: cachedSelector.date_attribute || null,
            date_regex: cachedSelector.date_regex || null,
          }
        : null;
    const pairs = applyLinkSelectorWithDates(
      html,
      cachedSelector.link_selector,
      cachedSelector.link_attribute || 'href',
      listingUrl,
      dateSpec,
    );
    const issues = pairs.filter((p) => isIssueUrl(p.url, listingUrl));
    if (issues.length) return issues.map((p) => ({ url: p.url, date: p.date || null }));
  }
  const $ = cheerio.load(html || '');
  const out = new Map();
  $('a[href]').each((_, a) => {
    const abs = normalizeUrl($(a).attr('href'), listingUrl);
    if (!abs || !isIssueUrl(abs, listingUrl) || out.has(abs)) return;
    const m = new URL(abs).pathname.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
    out.set(abs, m ? `${m[1]}-${m[2]}-${m[3]}` : null);
  });
  return [...out.entries()].map(([url, date]) => ({ url, date }));
}

/** Links EXTERNOS de uma issue (os itens curados) — mesmo critério do crawler: outro host. */
export function extractExternalLinks(html, pageUrl) {
  const $ = cheerio.load(html || '');
  const host = hostOf(pageUrl);
  const seen = new Set();
  $('a[href]').each((_, a) => {
    const abs = normalizeUrl($(a).attr('href'), pageUrl);
    if (!abs || hostOf(abs) === host) return;
    seen.add(abs);
  });
  return [...seen];
}

/** Data da issue em ISO (YYYY-MM-DD): página (extractPublishedDate) → data do URL/listagem. */
export function resolveIssueDate(html, listingDate) {
  const min = new Date('2010-01-01');
  const now = new Date();
  const iso = (s) => {
    const d = parseDate(s);
    return d && d >= min && d <= now ? d.toISOString().slice(0, 10) : null;
  };
  return iso(extractPublishedDate(html || '')) || iso(listingDate) || null;
}

// ---- aplicação --------------------------------------------------------------

function loadState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return { done: [] };
  }
}

const t = (s) => parseDate(s)?.getTime() ?? 0;

async function run() {
  const state = loadState();
  const done = new Set(state.done || []);
  const sources = stmts.listSources
    .all()
    .filter((s) => s.type === 'index' && s.base_url)
    .filter((s) => !sourceFilter || `${s.name} ${s.base_url}`.toLowerCase().includes(sourceFilter.toLowerCase()));
  if (!sources.length) {
    console.error('nenhuma fonte index casa com o filtro.');
    process.exit(1);
  }
  console.log(`fontes: ${sources.map((s) => s.name).join(', ')} · workers=${workers}${dryRun ? ' · DRY-RUN' : ''}`);

  const totals = { issues: 0, skipped: 0, attributed: 0, dated: 0, already: 0 };
  for (const src of sources) {
    let listingHtml;
    try {
      listingHtml = await get(src.base_url);
    } catch (e) {
      console.error(`listagem falhou (${src.base_url}): ${e.message}`);
      continue;
    }
    const cached = getCachedSelector(domainSig(src.base_url, 'listing'));
    let issues = extractIssueLinks(listingHtml, src.base_url, cached).filter((i) => !done.has(i.url));
    // Ordem cronológica: a issue mais antiga que menciona o link fica com ele (first-wins).
    issues.sort((a, b) => (t(a.date) || t(a.url)) - (t(b.date) || t(b.url)) || (a.url < b.url ? -1 : 1));
    if (Number.isFinite(maxIssues)) issues = issues.slice(0, maxIssues);
    console.log(`\n${src.name}: ${issues.length} issue(s) a processar`);
    totals.issues += issues.length;

    for (let i = 0; i < issues.length; i += workers) {
      const batch = issues.slice(i, i + workers);
      const pages = await Promise.all(
        batch.map(async (it) => {
          try {
            return { ...it, html: await get(it.url) };
          } catch (e) {
            return { ...it, error: e.message };
          }
        }),
      );
      // Aplicação ORDEADA (o Promise.all preserva a ordem do batch).
      for (const p of pages) {
        if (p.error) {
          totals.skipped++;
          console.log(`  ✗ ${p.url} — ${p.error}`);
          done.add(p.url);
          continue;
        }
        const date = resolveIssueDate(p.html, p.date);
        if (!date) {
          totals.skipped++;
          console.log(`  ? ${p.url} — sem data parseável, pulado`);
          done.add(p.url);
          continue;
        }
        let attributed = 0;
        let dated = 0;
        let already = 0;
        const links = extractExternalLinks(p.html, p.url);
        for (const link of links) {
          const row = stmts.getArticleFullByUrl.get(link);
          if (!row) continue;
          if (row.issue_url) {
            already++;
            if (row.published_at !== date) dated++; // alinhado pelo updateArticleDatesByIssue abaixo
            continue;
          }
          if (dryRun) {
            attributed++;
            continue;
          }
          const r = stmts.setIssueAttribution.run({ url: link, source_id: src.id, issue_url: p.url, date });
          if (r.changes > 0) attributed++;
        }
        if (!dryRun) dated += stmts.updateArticleDatesByIssue.run({ url: p.url, date }).changes;
        totals.attributed += attributed;
        totals.dated += dated;
        totals.already += already;
        done.add(p.url);
        if (attributed || dated) {
          console.log(`  ✓ ${p.url} → ${date} · ${attributed} atribuído(s) · ${dated} data(s) corrigida(s) (${links.length} links, ${already} já atribuídos)`);
        }
        if (!dryRun && done.size % 25 === 0) writeFileSync(statePath, JSON.stringify({ done: [...done] }));
      }
      if (!dryRun) writeFileSync(statePath, JSON.stringify({ done: [...done] }));
    }
  }

  console.log(
    `\nresumo: ${totals.issues} issue(s) · ${totals.attributed} item(ns) re-atribuídos · ` +
      `${totals.dated} data(s) corrigida(s) · ${totals.already} já atribuídos · ${totals.skipped} issue(s) pulada(s)`,
  );
  if (dryRun) console.log('DRY-RUN: nada foi escrito.');
  db.close();
}

/**
 * MODO `--target-dates [--date <prefixo>]`: itens AINDA SEM issue_url (links atrás do redirector
 * `/leave/*|UID|*` da Cooperpress — a URL real não existe no HTML da issue, então a atribuição
 * por issue não os alcança) ganham a DATA DO PRÓPRIO ALVO — o fallback documentado ("item AVULSO
 * mantém a data própria do alvo"). `--date` restringe a um prefixo de published_at (ex.:
 * `--date 2026-08-30` p/ os picos de data de captura que o `ncrawl audit` reporta).
 */
async function runTargetDates() {
  const datePrefix = flag('--date') || null;
  const sourceId = sourceFilter
    ? stmts.listSources.all().find((s) => `${s.name} ${s.base_url}`.toLowerCase().includes(sourceFilter.toLowerCase()))?.id ?? -1
    : null;
  const rows = stmts.listArticlesWithoutIssue.all({ date: datePrefix, sourceId, lim: 100000 });
  console.log(`target-dates: ${rows.length} item(ns) sem issue_url${datePrefix ? ` em ${datePrefix}` : ''}${dryRun ? ' · DRY-RUN' : ''}`);
  let fixed = 0;
  let unchanged = 0;
  let dead = 0;
  for (let i = 0; i < rows.length; i += workers) {
    const batch = rows.slice(i, i + workers);
    const pages = await Promise.all(
      batch.map(async (row) => {
        try {
          return { row, html: await get(row.url) };
        } catch (e) {
          return { row, error: e.message };
        }
      }),
    );
    for (const p of pages) {
      if (p.error) {
        dead++;
        continue;
      }
      const date = resolveIssueDate(p.html, null);
      if (!date || date === p.row.published_at) {
        unchanged++;
        continue;
      }
      if (!dryRun) stmts.setArticleOwnDate.run({ id: p.row.id, date });
      fixed++;
      console.log(`  ✓ ${p.row.url.slice(0, 72)} → ${date} (era ${p.row.published_at || 'NULL'})`);
    }
  }
  console.log(`\nresumo: ${fixed} data(s) do alvo aplicada(s) · ${unchanged} sem data nova · ${dead} alvo(s) morto(s)/inacessível(is)`);
  if (dryRun) console.log('DRY-RUN: nada foi escrito.');
  db.close();
}

// Só roda o pipeline quando executado diretamente (os exports acima são p/ teste).
if (import.meta.url === `file://${process.argv[1]}`) {
  const pipeline = args.includes('--target-dates') ? runTargetDates : run;
  pipeline().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
