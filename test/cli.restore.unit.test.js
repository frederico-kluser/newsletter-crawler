// Unidades puras de src/cli-restore.js — o que a e2e da CLI não consegue provocar de propósito:
// a troca de arquivo do `backup restore` recusando origem inexistente e origem == destino, e a
// resolução de `latest`/`best`/nome/caminho.
// NC_HOME em tmpdir ANTES de qualquer import de src/ (contrato do repo: import DINÂMICO).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const NC_HOME_TMP = mkdtempSync(path.join(os.tmpdir(), 'nc-cliunit-'));
process.env.NC_HOME = NC_HOME_TMP;
writeFileSync(path.join(NC_HOME_TMP, '.env'), 'OPENROUTER_API_KEY=\nDEEPSEEK_API_KEY=\nLLM_PROVIDER=\n');
const { db } = await import('../src/db.js');
const { BOOTSTRAP_COMMANDS, backupListLines, resolveBackupRef, restoreReportLines, shouldBootstrap, swapDatabaseFile } =
  await import('../src/cli-restore.js');

const tmps = [NC_HOME_TMP];
after(() => {
  db.close();
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});
function tmpdir(prefix) {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(d);
  return d;
}

test('shouldBootstrap: só a allowlist, e nada de reset/purge/key/deploy/EXPORT', () => {
  for (const c of ['crawl', 'finish', 'search', 'web', 'ui', 'menu', 'status']) {
    assert.equal(shouldBootstrap(c), true, c);
    assert.ok(BOOTSTRAP_COMMANDS.has(c));
  }
  for (const c of ['reset', 'clean', 'purge', 'remove', 'key', 'limits', 'add', 'deploy', 'inspect', 'restore', 'backup']) {
    assert.equal(shouldBootstrap(c), false, c);
  }
  // `export` SAIU da allowlist: o .githooks/pre-push roda `export --format web` a cada push, e um
  // bootstrap ali reescreveria o banco do usuário em TODO `git push` com a base vazia, calado. Quem
  // impede o snapshot vazio agora é o guard DENTRO do exportWebSnapshot, não o bootstrap.
  assert.equal(shouldBootstrap('export'), false, 'export NÃO pode disparar restauração (é o que o pre-push roda)');
  assert.ok(!BOOTSTRAP_COMMANDS.has('export'));
  assert.equal(shouldBootstrap(undefined), false, 'sem comando (ajuda) não dispara');
  assert.equal(shouldBootstrap(''), false);
});

test('swapDatabaseFile: origem inexistente NÃO fecha nem apaga nada', () => {
  const dir = tmpdir('nc-swap-a-');
  const dbFile = path.join(dir, 'crawler.db');
  writeFileSync(dbFile, 'banco vivo');
  let fechou = false;
  const res = swapDatabaseFile(path.join(dir, 'nao-existe.db'), { dbPath: dbFile, close: () => { fechou = true; } });
  assert.equal(res.ok, false);
  assert.match(res.error, /arquivo de origem não existe/);
  assert.equal(fechou, false, 'nem chegou a fechar a conexão');
  assert.equal(readFileSync(dbFile, 'utf8'), 'banco vivo', 'o banco continua intacto');
});

test('swapDatabaseFile: origem == destino é recusada (senão apagaria o próprio arquivo)', () => {
  const dir = tmpdir('nc-swap-b-');
  const dbFile = path.join(dir, 'crawler.db');
  writeFileSync(dbFile, 'banco vivo');
  const res = swapDatabaseFile(dbFile, { dbPath: dbFile, close: () => {} });
  assert.equal(res.ok, false);
  assert.match(res.error, /MESMO arquivo/);
  assert.ok(existsSync(dbFile), 'nada foi apagado');
});

test('swapDatabaseFile: fecha, apaga .db + -wal + -shm e copia (o backup CONTINUA existindo)', () => {
  const dir = tmpdir('nc-swap-c-');
  const dbFile = path.join(dir, 'crawler.db');
  const src = path.join(dir, 'copia.db');
  writeFileSync(dbFile, 'banco velho');
  writeFileSync(`${dbFile}-wal`, 'wal velho');
  writeFileSync(`${dbFile}-shm`, 'shm velho');
  writeFileSync(src, 'banco bom');
  const ordem = [];
  const res = swapDatabaseFile(src, { dbPath: dbFile, close: () => ordem.push('close') });
  assert.deepEqual(res, { ok: true, error: null });
  assert.deepEqual(ordem, ['close'], 'a conexão é fechada ANTES de mexer no arquivo');
  assert.equal(readFileSync(dbFile, 'utf8'), 'banco bom');
  assert.ok(!existsSync(`${dbFile}-wal`), '-wal apagado (senão seria reaplicado por cima)');
  assert.ok(!existsSync(`${dbFile}-shm`), '-shm apagado');
  assert.ok(existsSync(src), 'copyFileSync, não rename: a cópia sobrevive à reposição');
});

test('resolveBackupRef: latest/best em diretório vazio devolvem ERRO legível, nunca null solto', () => {
  const dir = tmpdir('nc-ref-');
  for (const ref of ['latest', 'best', undefined]) {
    const r = resolveBackupRef(ref, { dir });
    assert.ok(r.error, `${ref}: erro esperado`);
    assert.match(r.error, /nenhum backup/);
  }
  const solto = path.join(dir, 'qualquer.db');
  writeFileSync(solto, 'nao e sqlite');
  // CAMINHO explícito vale mesmo fora do padrão de nome — mas ilegível vira articles:null e quem
  // chama (cmdBackup) recusa a reposição.
  const porCaminho = resolveBackupRef(solto, { dir });
  assert.equal(porCaminho.file, solto);
  assert.equal(porCaminho.articles, null, 'arquivo que não é SQLite é sinalizado, não aceito em silêncio');
  const porNome = resolveBackupRef('qualquer.db', { dir });
  assert.equal(porNome.file, solto, 'nome resolve contra o BACKUP_DIR');
  assert.match(resolveBackupRef('sumiu.db', { dir }).error, /backup não encontrado: "sumiu\.db"/);
});

test('backupListLines: lista vazia diz onde procurou; com itens mostra artigos, tamanho e data', () => {
  assert.deepEqual(backupListLines([], '/tmp/x'), ['nenhum backup em /tmp/x.']);
  const lines = backupListLines(
    [{ name: 'crawler-20260905T120000Z-reset.db', articles: 3249, bytes: 2 * 1048576, mtime: new Date('2026-09-05T12:00:00Z'), reason: 'reset' }],
    '/tmp/x',
  );
  assert.match(lines[0], /^1 backup\(s\) em \/tmp\/x/);
  assert.match(lines[1], /crawler-20260905T120000Z-reset\.db\s+3249 artigo\(s\)\s+2\.0 MB\s+2026-09-05T12:00:00\.000Z\s+\(reset\)/);
});

test('restoreReportLines: o dry-run NUNCA imprime linha de aplicação', () => {
  const res = {
    report: { commits: 2, snapshots: [1, 2], articles: 4, withBody: 4, withSummary: 4, withTags: 4, withDate: 4, bodyPolicy: 'best' },
    selected: 4, keptId: 3, freshId: 1, inserted: 0, tags: 0, classifications: 0, frontier: 0, pages: 0, sources: 0,
    skippedRows: {}, before: { articles: 0, tags: 0 }, after: { articles: 0, tags: 0 }, ms: 10,
  };
  const seco = restoreReportLines(res, { dryRun: true });
  assert.ok(seco.every((l) => l.startsWith('[dry-run]')), 'toda linha marcada');
  assert.ok(!seco.some((l) => /aplicado:/.test(l)));
  const molhado = restoreReportLines({ ...res, inserted: 4, after: { articles: 4, tags: 9 } }, {});
  assert.ok(molhado.some((l) => /aplicado: 4 artigo\(s\) repostos/.test(l)));
  assert.ok(molhado.some((l) => /base: 0 → 4 artigo\(s\), 0 → 9 tag\(s\)/.test(l)));
});
