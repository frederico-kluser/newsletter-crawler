#!/usr/bin/env node
// Limpa os PLACEHOLDERS de truncamento que a curadoria deixou entrar no acervo ("github.com/...",
// "https://..", "x.com/…" — 32 artigos + 31 frontier medidos em 2026-10-10, todos PUBLICADOS no
// snapshot). A prevenção vive em `isPlausibleUrl` (src/util.js) nos pontos de entrada; este script
// é a REMEDIAÇÃO do que já entrou.
//
//   node scripts/purge-truncated-urls.mjs          # DRY-RUN: lista o que seria removido
//   node scripts/purge-truncated-urls.mjs --yes    # apaga (articles + cascatas + frontier + events)
//
// Idempotente (2ª corrida = nada a fazer). Usa a MESMA regra do runtime (importa isPlausibleUrl),
// nunca uma regex paralela que pudesse divergir. Tudo dentro de UMA transação.
// Antes de `--yes` em base viva, tire backup: `ncrawl backup`.
import Database from 'better-sqlite3';
import { load as loadVec } from 'sqlite-vec';
import path from 'node:path';
import os from 'node:os';
import { isPlausibleUrl } from '../src/util.js';

const yes = process.argv.includes('--yes');
const home = process.env.NC_HOME ? path.resolve(process.env.NC_HOME) : path.join(os.homedir(), '.newsletter-crawler');
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(home, 'crawler.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// sqlite-vec (como o src/db.js): sem o módulo carregado, o TRIGGER articles_vec_ad (limpeza do
// vetor no delete) responde "no such module: vec0" e o DELETE falha.
try {
  loadVec(db);
} catch { /* fail-open: sem busca densa, os deletes seguem */ }

const urls = [
  ...new Set([
    ...db.prepare('SELECT url FROM articles').all().map((r) => r.url),
    ...db.prepare('SELECT url FROM frontier').all().map((r) => r.url),
    ...db.prepare('SELECT url FROM pages').all().map((r) => r.url),
  ]),
].filter((u) => u && !isPlausibleUrl(u));

if (!urls.length) {
  console.log('purge-truncated-urls: nada a limpar ✓');
  process.exit(0);
}

const arts = db.prepare(`SELECT id, url FROM articles WHERE url IN (${urls.map(() => '?').join(',')})`).all(...urls);
const frt = db.prepare(`SELECT COUNT(*) c FROM frontier WHERE url IN (${urls.map(() => '?').join(',')})`).get(...urls).c;
const pgs = db.prepare(`SELECT COUNT(*) c FROM pages WHERE url IN (${urls.map(() => '?').join(',')})`).get(...urls).c;

console.log(`purge-truncated-urls: ${arts.length} artigo(s), ${frt} frontier, ${pgs} page(s) com URL implausível:`);
for (const a of arts) console.log(`  #${a.id} ${a.url}`);
if (!yes) {
  console.log('\nDRY-RUN — nada foi apagado. Confirme e rode com --yes (tire backup antes: ncrawl backup).');
  process.exit(0);
}

const del = db.transaction(() => {
  const ids = arts.map((a) => a.id);
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM article_tags WHERE article_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM classifications WHERE article_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM articles WHERE id IN (${ph})`).run(...ids);
  }
  const uph = urls.map(() => '?').join(',');
  db.prepare(`DELETE FROM frontier WHERE url IN (${uph})`).run(...urls);
  db.prepare(`DELETE FROM pages WHERE url IN (${uph})`).run(...urls);
  db.prepare(`DELETE FROM events WHERE url IN (${uph})`).run(...urls);
});
del();
console.log(`\nAPAGADO ✓ (${arts.length} artigo(s) + ${frt} frontier + ${pgs} page(s) + eventos)`);
console.log('NOTA: o próximo export publica MENOS artigos — o guard anti-encolhimento exige');
console.log('      `npm run deploy -- --allow-shrink` (redução INTENCIONAL, agora documentada).');
