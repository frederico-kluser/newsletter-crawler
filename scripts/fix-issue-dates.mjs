// Backfill de datas por issue (onda P1): corrige published_at de TODOS os artigos de UMA issue —
// a issue é a âncora temporal de todos os seus itens. Na run real #1, 13/15 artigos da issue 637
// da Node Weekly ficaram com a data do ALVO (08-05) espalhada, 1 com 07-13 e 1 NULL — a data certa
// é a da issue (2026-08-13). Roda contra o banco REAL (NC_HOME/crawler.db). Idempotente: re-rodar
// com os mesmos args → 0 linhas.
// Script throwaway → console direto é permitido (following-code-style: escape hatch p/ scripts).
// Rodar: node scripts/fix-issue-dates.mjs --issue-url <url> --date <YYYY-MM-DD> [--dry-run]
import { stmts, db } from '../src/db.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const issueUrl = flag('--issue-url');
const date = flag('--date');
const dryRun = args.includes('--dry-run');

if (!issueUrl || !date) {
  console.error('Uso: node scripts/fix-issue-dates.mjs --issue-url <url> --date <YYYY-MM-DD> [--dry-run]');
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`Data inválida (esperado YYYY-MM-DD): ${date}`);
  process.exit(1);
}

// Só leitura — a escrita vai pelo stmts.updateArticleDatesByIssue (fonte única de SQL p/ escrita).
const distribution = db.prepare(`
  SELECT published_at, COUNT(*) AS n FROM articles
  WHERE issue_url = ? GROUP BY published_at ORDER BY published_at
`);
const total = db.prepare('SELECT COUNT(*) AS n FROM articles WHERE issue_url = ?').get(issueUrl).n;

console.log(`issue: ${issueUrl} · alvo: ${date} · artigos: ${total}${dryRun ? ' · DRY-RUN (não altera)' : ''}`);

const printDistribution = (label) => {
  console.log(`\nDistribuição ${label} por published_at:`);
  const rows = distribution.all(issueUrl);
  if (!rows.length) console.log('  (nenhum artigo para essa issue_url)');
  for (const row of rows) console.log(`  ${String(row.published_at ?? 'NULL').padEnd(12)} × ${row.n}`);
};

printDistribution('ANTES');

if (dryRun) {
  console.log('\nDRY-RUN: nada alterado. Rode sem --dry-run para aplicar.');
  process.exit(0);
}

const { changes } = stmts.updateArticleDatesByIssue.run({ url: issueUrl, date });
console.log(`\n${changes} linha(s) atualizada(s).`);

printDistribution('DEPOIS');
