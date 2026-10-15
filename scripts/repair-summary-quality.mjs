#!/usr/bin/env node
// Repara a camada de LEITURA (title_pt/summary_pt) para a regra do produto (2026-10-10): SEMPRE
// PT-BR, legível, sem HTML residual. Medido no acervo: ~15 resumos em EN + ~70 duvidosos + 25 com
// tags HTML estruturais + 68 com palavras coladas + títulos em EN.
//
// AÇÃO: summary_pt = NULL + title_pt = NULL -> o `finish` re-sumariza (invariante NULL-idempotente)
// e o guarda NOVO (looksPortuguese + stripDisplayJunk no src/llm.js) garante que o que voltar já
// nasce PT e limpo. Detecção = MESMOS helpers do runtime (nunca uma regra paralela).
//
//   node scripts/repair-summary-quality.mjs          # DRY-RUN
//   node scripts/repair-summary-quality.mjs --yes    # aplica (uma transação)
import Database from 'better-sqlite3';
import { load as loadVec } from 'sqlite-vec';
import path from 'node:path';
import os from 'node:os';
import { looksPortuguese, hasCjk, cjkRatio, stripDisplayJunk, isRefusalText } from '../src/util.js';

const yes = process.argv.includes('--yes');
const home = process.env.NC_HOME ? path.resolve(process.env.NC_HOME) : path.join(os.homedir(), '.newsletter-crawler');
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(home, 'crawler.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
try { loadVec(db); } catch { /* fail-open */ }

const TAGJUNK = /<\/?(?:div|p|br|span|a|img|ul|ol|li|table|tr|td|th|section|article|header|footer|nav|h[1-6])\b/i;
const ENT = /&(?:#?\w{1,8});/;
const MDLINK = /\[[^\]\n]{1,200}\]\(https?:\/\/[^)\s]{1,400}\)/;
const GLUED = /[a-z]\.[a-z]{2,}\d|\d\.[a-z]{2,}|[a-z]{3,}\d{2,}\.[a-z]/;
// O que NÃO é colagem: versões, domínios/extensões e identificadores técnicos ("5.js", "1.org",
// "e.move2", "Go101.org") — normais num resumo PT de tecnologia (medido 2026-10-15: 43 dos 44
// matches eram destes; só 1 colagem real).
const GLUED_TECH = /^(\d+\.\d*[a-z]*|\w+\.\w*\d\w*|\w+\.(js|ts|jsx|tsx|mjs|cjs|org|com|net|dev|io|co|ai|app|py|rs|go|md|json|ya?ml|css|html|php|rb|java|kt|swift))$/i;

function problemsOf(row) {
  const out = [];
  for (const field of ['title_pt', 'summary_pt']) {
    const t = row[field];
    if (t == null) continue;
    // CJK: MESMA régua do runtime (summaryInWrongLanguage em src/llm.js) — título com qualquer
    // CJK reprova; no RESUMO só a razão > 0.25 (identificadores UTF-8 citados são CONTEúdo:
    // PRs de Rust sobre UTF-8 multibyte citam 中文 em backticks e são PT perfeitos).
    if (field === 'title_pt' ? hasCjk(t) : cjkRatio(t) > 0.25) out.push(`${field}:cjk`);
    if (!looksPortuguese(t)) out.push(`${field}:idioma`); // título TAMBÉM tem de ler-se PT
    // HTML estrutural FORA de citações de código (`<div>` citado em backticks é conteúdo — o
    // stripDisplayJunk preserva de propósito): iguala o runtime antes de reprovar.
    if (TAGJUNK.test(String(t).replace(/`[^`\n]{1,200}`/g, ' '))) out.push(`${field}:html`);
    if (ENT.test(t)) out.push(`${field}:entidade`);
    if (MDLINK.test(t)) out.push(`${field}:markdown`);
    const glued = [...String(t).matchAll(new RegExp(GLUED.source, 'g'))].map((m) => m[0]);
    if (glued.some((m) => !GLUED_TECH.test(m))) out.push(`${field}:colado`);
    if (isRefusalText(t)) out.push(`${field}:recusa`);
    if (field === 'summary_pt' && String(t).trim().length < 60) out.push(`${field}:curto`);
    if (stripDisplayJunk(t) !== t.replace(/\s+/g, ' ').trim()) out.push(`${field}:lixo-display`);
  }
  return out;
}

const rows = db.prepare('SELECT id, run_id, title_pt, summary_pt FROM articles WHERE summary_pt IS NOT NULL OR title_pt IS NOT NULL').all();
const alvo = rows.map((r) => ({ r, p: problemsOf(r) })).filter((x) => x.p.length);

const era = (run) => (run == null ? 'LEGADO' : `era ${run}`);
const porEra = {};
for (const { r } of alvo) porEra[era(r.run_id)] = (porEra[era(r.run_id)] || 0) + 1;
console.log(`repair-summary-quality: ${alvo.length} ficha(s) com title_pt/summary_pt fora da regra (${JSON.stringify(porEra)})`);
for (const { r, p } of alvo.slice(0, 8)) console.log(`  #${r.id} [${p.join(', ')}] ${String(r.summary_pt || r.title_pt).slice(0, 60)}`);

if (!yes) {
  console.log('\nDRY-RUN — nada foi tocado. Rode com --yes e depois: npm run finish -- --include-legacy --yes --budget 0.30');
  process.exit(0);
}

const upd = db.prepare('UPDATE articles SET summary_pt = NULL, title_pt = NULL WHERE id = ?');
db.transaction(() => { for (const { r } of alvo) upd.run(r.id); })();
console.log(`\nNULL aplicado a ${alvo.length} ficha(s) ✓ — re-sumarize com:`);
console.log('  npm run finish -- --include-legacy --yes --budget 0.30');
