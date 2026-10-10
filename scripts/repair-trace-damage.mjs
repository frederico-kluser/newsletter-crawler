#!/usr/bin/env node
// Repara o DANO medido no acervo pela análise do trace --llm-dev (2026-10-10):
//
//   A) SUMÁRIOS danificados (gigantes >2000c, com JSON/código, com loops de repetição)
//      -> summary_pt = NULL  (o `finish` re-sumariza; invariante NULL-idempotente)
//   B) FICHAS com conteúdo = só título/nav mas verify='ok' (557 medidas: 546 legado 'restore')
//      -> needs_enrich = 1 + verify_status = NULL + summary_pt = NULL
//      O conteúdo real vem pelo pipeline de ENRIQUECIMENTO (requeueNeedsEnrichForSource no
//      próximo crawl: fetch do alvo + extract + clean + verify/summarize streaming). O
//      `reextract` não serve aqui: a seleção dele é só content_source='target'.
//
//   As fichas 'aggregator' finas são kept-blurb POR DESIGN (alvo raso/bloqueado não se perde)
//   e ficam de fora. Idem artigos sem tags: o sweep de classify apanha-os sozinho.
//
//   node scripts/repair-trace-damage.mjs          # DRY-RUN: conta e mostra o alvo
//   node scripts/repair-trace-damage.mjs --yes    # aplica (uma transação)
//
// Idempotente: a 2ª corrida não acha nada (os campos já estão NULL / needs_enrich).
import Database from 'better-sqlite3';
import { load as loadVec } from 'sqlite-vec';
import path from 'node:path';
import os from 'node:os';

const yes = process.argv.includes('--yes');
const home = process.env.NC_HOME ? path.resolve(process.env.NC_HOME) : path.join(os.homedir(), '.newsletter-crawler');
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(home, 'crawler.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
try { loadVec(db); } catch { /* fail-open */ }

// ---- detecção (as MESMAS assinaturas medidas no audit) ----

function hasRealLoop(s) {
  for (let j = 0; j < Math.max(0, s.length - 120); j += 37) {
    const blk = s.slice(j, j + 40);
    if (blk.length === 40 && s.split(blk).length - 1 >= 3) return true;
  }
  return false;
}

const summaries = db.prepare('SELECT id, run_id, summary_pt FROM articles WHERE summary_pt IS NOT NULL').all();
const danifSum = summaries
  .filter(({ summary_pt: s }) => {
    const t = s.trim();
    return s.length > 2000 || t.startsWith('{') || t.startsWith('[') || s.includes('```') || hasRealLoop(s);
  })
  .map((r) => r.id);

const finas = db.prepare(
  `SELECT id FROM articles
    WHERE length(content) BETWEEN 1 AND 200 AND verify_status = 'ok' AND content_source != 'aggregator'`,
).all().map((r) => r.id);

const era = (id) => db.prepare('SELECT run_id FROM articles WHERE id = ?').get(id).run_id;
const porEra = (ids) => ids.reduce((m, i) => {
  const k = era(i) == null ? 'LEGADO' : `era ${era(i)}`;
  m[k] = (m[k] || 0) + 1;
  return m;
}, {});

console.log(`repair-trace-damage: ${danifSum.length} sumário(s) danificado(s) -> NULL (${JSON.stringify(porEra(danifSum))})`);
console.log(`repair-trace-damage: ${finas.length} ficha(s) fina(s) 'ok' -> re-enriquecer (${JSON.stringify(porEra(finas))})`);
if (!yes) {
  console.log('\nDRY-RUN — nada foi tocado. Rode com --yes para aplicar.');
  process.exit(0);
}

const run = db.transaction(() => {
  const nullSum = db.prepare('UPDATE articles SET summary_pt = NULL WHERE id = ?');
  for (const id of danifSum) nullSum.run(id);
  const enrich = db.prepare(
    'UPDATE articles SET needs_enrich = 1, verify_status = NULL, verify_notes = NULL, summary_pt = NULL WHERE id = ?',
  );
  for (const id of finas) enrich.run(id);
});
run();
console.log('\nAPAGADO/RE-ENFILEIRADO ✓');
console.log('Seguinte (nesta ordem):');
console.log('  1. npm run crawl -- --budget 1.20   # drena o enriquecimento (conteúdo real) + streaming');
console.log('  2. npm run finish --include-legacy --yes --budget 0.60   # re-sumariza os 68 + drena pendentes legados');
