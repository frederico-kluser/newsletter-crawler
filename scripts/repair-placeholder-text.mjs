#!/usr/bin/env node
// Repara as RECUSAS/meta-texto que viveram como conteúdo/resumo da camada de leitura
// ("Artigo não fornecido", "Nenhum artigo fornecido", "Não foi possível extrair o conteúdo porque
// o texto do artigo não foi fornecido.", "…é uma mensagem de verificação de página web").
// Medido 2026-10-15: 252 fichas (122 title_pt + ~68 summary_pt + content com desculpas de extração).
//
// AÇÃO (por ficha afetada):
//   - title_pt/summary_pt com recusa            -> NULL -> `finish` re-sumariza (guardas novos em
//     src/llm.js nunca persistem recusa de novo);
//   - content com recusa                        -> content = NULL + needs_enrich = 1 -> a PRÓXIMA
//     run re-enriquece do alvo (política ENRICH_MAX_ATTEMPTS=0) e, sem corpo real, fica no blurb;
//   - title_pt/summary_pt DERIVADOS de content-recusa também -> NULL (re-resumem do título+blurb).
//
// Detecção = MESMO helper do runtime (`isRefusalText`, src/util.js) — nunca uma regex paralela
// (regra 2026-10-10). O conteúdo olha-se até aos 200 chars do COMEÇO (uma recusa é o texto todo).
//
//   node scripts/repair-placeholder-text.mjs          # DRY-RUN
//   node scripts/repair-placeholder-text.mjs --yes    # aplica (uma transação)
import Database from 'better-sqlite3';
import { load as loadVec } from 'sqlite-vec';
import path from 'node:path';
import os from 'node:os';
import { isRefusalText } from '../src/util.js';
import { isErrorPage, isBlockedPage, looksLikeJson } from '../src/parse-core.js';

const yes = process.argv.includes('--yes');
const home = process.env.NC_HOME ? path.resolve(process.env.NC_HOME) : path.join(os.homedir(), '.newsletter-crawler');
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(home, 'crawler.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
try { loadVec(db); } catch { /* fail-open */ }

// `content` que não é artigo: recusa/meta-texto, página de erro (403/500/parqueada), interstitial
// anti-bot ou JSON de dados — MESMOS guardas do runtime (util/parse-core), nunca regex paralela.
// Interstitial só descarta quando É a página toda (corpo curto): "Just a moment." colado no meio
// de um artigo longo é contaminação de extração (ex. #9998), não motivo para perder o artigo.
const contentIsGarbage = (r) => {
  const len = String(r.content || '').length;
  if (isRefusalText(r.content)) return true;
  if (looksLikeJson(r.content)) return true;
  if (isErrorPage(r.title, r.content)) return true;
  return isBlockedPage(r.title, r.content) && len < 1200;
};

const rows = db.prepare('SELECT id, run_id, url, title, title_pt, summary_pt, content, needs_enrich FROM articles').all();
const blank = (v) => v != null && !String(v).trim(); // "" ou só espaços: guardas do summarize rejeitam
const alvo = [];
for (const r of rows) {
  const contentBad = Boolean(r.content) && contentIsGarbage(r);
  const readBad =
    isRefusalText(r.title_pt) || isRefusalText(r.summary_pt) || blank(r.title_pt) || blank(r.summary_pt);
  const titleBad = isRefusalText(r.title);
  if (contentBad || readBad || titleBad) {
    alvo.push({ r, contentBad, readBad, titleBad });
  }
}

const era = (run) => (run == null ? 'LEGADO' : `era ${run}`);
const porEra = {};
let nContent = 0;
let nRead = 0;
let nTitle = 0;
for (const { r, contentBad, readBad, titleBad } of alvo) {
  porEra[era(r.run_id)] = (porEra[era(r.run_id)] || 0) + 1;
  if (contentBad) nContent++;
  if (readBad) nRead++;
  if (titleBad) nTitle++;
}
console.log(
  `repair-placeholder-text: ${alvo.length} ficha(s) com recusa/meta-texto ` +
    `(content=${nContent} · title_pt/summary_pt=${nRead} · title=${nTitle}) ${JSON.stringify(porEra)}`,
);
for (const { r, contentBad, readBad } of alvo.slice(0, 8)) {
  const parts = [contentBad ? 'content' : null, readBad ? 'leitura' : null].filter(Boolean).join('+');
  const amostra = contentBad ? r.content : r.summary_pt || r.title_pt;
  console.log(`  #${r.id} [${parts}] ${String(amostra || '').slice(0, 64)}`);
}
if (nTitle > 0) {
  console.log(
    `  ⚠ ${nTitle} ficha(s) com TITLE original em recusa — o título vira o do agregador no re-enriquecimento;`,
  );
  console.log('    (nestas fichas o content=NULL + needs_enrich=1 resolve o título também)');
}

if (!yes) {
  console.log('\nDRY-RUN — nada foi tocado. Rode com --yes e depois:');
  console.log('  npm run finish -- --include-legacy --yes');
  process.exit(0);
}

const clearRead = db.prepare('UPDATE articles SET title_pt = NULL, summary_pt = NULL WHERE id = ?');
// content_source volta a 'aggregator' (fica SÓ o blurb) — é o mesmo estado de um kept-blurb.
const clearContent = db.prepare(
  "UPDATE articles SET content = NULL, needs_enrich = 1, content_source = 'aggregator' WHERE id = ?",
);
db.transaction(() => {
  for (const { r, contentBad, readBad } of alvo) {
    if (contentBad) clearContent.run(r.id);
    if (contentBad || readBad) clearRead.run(r.id);
  }
})();
console.log(`\nNULL aplicado em ${alvo.length} ficha(s) ✓ — re-resumir com:`);
console.log('  npm run finish -- --include-legacy --yes');
