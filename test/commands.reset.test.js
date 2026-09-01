// `npm run reset -- --yes` (cmdReset): depois do wipeAll, APAGA do git (ou do disco, fora de
// repo) o snapshot do site COMMITADO (webapp/public/data + webapp/public/api/v1) — senão o guard
// fail-open do pre-push/deploy ("snapshot menor que o commitado → restaura") manteria o JSON
// velho no ar e o sistema "sempre usaria" o arquivo. NC_HOME temporário ANTES do import
// (commands.js -> db.js); repo git scratch p/ o caminho git, dir sem .git p/ o caminho fs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-reset-'));
// NC_HOME/.env vazio vence o .env do REPO real (precedência: shell < repo < NC_HOME) — reset não
// toca LLM, mas o determinismo dos imports (config.js) agradece. Mesmo padrão dos testes de config.
writeFileSync(
  path.join(process.env.NC_HOME, '.env'),
  'OPENROUTER_API_KEY=\nDEEPSEEK_API_KEY=\nLLM_PROVIDER=\n',
);

const { cmdReset, removeSiteSnapshot } = await import('../src/commands.js');
const { stmts, db } = await import('../src/db.js');
const { setLogSink } = await import('../src/util.js');

// Captura os logs (contrato {level, text}) p/ assertar a mensagem do reset e a recusa.
const logs = [];
setLogSink((e) => logs.push(e));

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

// ---- helpers ----

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

function seedArticle() {
  const src = stmts.upsertSource.get({
    name: 'ResetFeed', base_url: 'https://reset.test', type: 'listing', max_index_pages: null,
  });
  stmts.insertArticle.run({
    source_id: src.id,
    url: 'https://reset.test/artigo-1',
    title: 'Artigo 1',
    content: 'conteúdo do artigo para o reset',
    content_hash: 'hash-reset-1',
    published_at: '2026-08-13',
    run_id: null,
    kind: 'news',
    issue_url: null,
    section: null,
    blurb: null,
    content_source: 'target',
    cleaned: 0,
    needs_enrich: 0,
  });
}

const snapshotDirs = (dir) => ({
  data: path.join(dir, 'webapp', 'public', 'data'),
  api: path.join(dir, 'webapp', 'public', 'api', 'v1'),
});

function writeSnapshotFiles(dir) {
  const { data, api } = snapshotDirs(dir);
  mkdirSync(data, { recursive: true });
  mkdirSync(api, { recursive: true });
  writeFileSync(path.join(data, 'meta.json'), '{"totals":{"articles":13701}}');
  writeFileSync(path.join(api, 'corpus.json'), '[]');
}

function makeGitRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-reset-git-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeSnapshotFiles(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'snapshot inicial');
  return dir;
}

// ---- testes ----

test('reset --yes num repo git: banco zerado + snapshot fora do índice e do disco + log', () => {
  const repo = makeGitRepo();
  seedArticle();
  assert.equal(stmts.countArticles.get().c, 1, 'artigo semeado antes do reset');

  logs.length = 0;
  const out = removeSiteSnapshot(repo);
  assert.equal(out.mode, 'git', 'caminho git detectado');

  // Integração completa (mesmo caminho do CLI): wipeAll + remoção do snapshot.
  cmdReset({ yes: true }, { root: repo });

  assert.equal(stmts.countArticles.get().c, 0, 'banco zerado');
  assert.ok(!existsSync(path.join(repo, 'webapp', 'public', 'data', 'meta.json')), 'meta.json removido do disco');
  assert.ok(!existsSync(path.join(repo, 'webapp', 'public', 'api', 'v1', 'corpus.json')), 'corpus.json removido do disco');
  assert.equal(
    git(repo, 'ls-files', '--', 'webapp/public/data', 'webapp/public/api/v1'),
    '',
    'arquivos fora do índice git',
  );
  assert.ok(
    logs.some((l) => l.text.includes('snapshot do site removido do git (webapp/public/data + api/v1)')),
    'log contém a mensagem do snapshot removido',
  );
  rmSync(repo, { recursive: true, force: true });
});

test('reset --yes fora de repo git: apaga os arquivos do disco (fail-open) e zera o banco', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-reset-fs-'));
  writeSnapshotFiles(dir);
  seedArticle();

  const out = removeSiteSnapshot(dir);
  assert.equal(out.mode, 'fs', 'caminho sem git detectado');

  cmdReset({ yes: true }, { root: dir });

  assert.equal(stmts.countArticles.get().c, 0, 'banco zerado');
  assert.ok(!existsSync(path.join(dir, 'webapp', 'public', 'data', 'meta.json')), 'meta.json removido');
  assert.ok(!existsSync(path.join(dir, 'webapp', 'public', 'api', 'v1', 'corpus.json')), 'corpus.json removido');
  rmSync(dir, { recursive: true, force: true });
});

test('reset sem --yes recusa (errorLog de confirmação + exit 1)', () => {
  const originalExit = process.exit;
  let exitCode = null;
  process.exit = (code) => {
    exitCode = code;
    throw new Error(`EXIT:${code}`);
  };
  logs.length = 0;
  try {
    cmdReset({});
    assert.fail('deveria ter chamado process.exit');
  } catch (e) {
    assert.match(String(e.message), /EXIT:1/);
  } finally {
    process.exit = originalExit;
  }
  assert.equal(exitCode, 1, 'process.exit(1)');
  assert.ok(
    logs.some((l) => l.level === 'error' && l.text.includes('Confirme com:  npm run reset -- --yes')),
    'errorLog pede a confirmação com --yes',
  );
});
