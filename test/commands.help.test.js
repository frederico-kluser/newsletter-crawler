// `--help`/`-h`/`--version`/`-V` NÃO disparam efeito colateral nenhum: mostram ajuda/versão e
// saem 0. Regressão do acidente real (crawl --help INICIAVA o crawl e gastou US$ 0,0147): agora
// o parse intercepta antes do dispatch. Subprocesso real + NC_HOME tmp com .env semeado vazio
// (padrão do commands.reextract.test.js — neutraliza o ROOT/.env real da máquina).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-help-'));
writeFileSync(
  path.join(process.env.NC_HOME, '.env'),
  'OPENROUTER_API_KEY=\nDEEPSEEK_API_KEY=\nLLM_PROVIDER=\n',
);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Mesmo NC_HOME tmp no processo de TESTE p/ inspecionar o banco que o subprocesso veria.
const { stmts, db } = await import('../src/db.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

const run = (args) =>
  spawnSync(process.execPath, ['src/index.js', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env },
  });

test('crawl --help: mostra a ajuda, sai 0 e NÃO inicia crawl (sem run, sem log de execução)', () => {
  const child = run(['crawl', '--help']);
  assert.equal(child.status, 0, `falhou: ${child.stderr || child.stdout}`);
  assert.match(child.stdout, /uso:/, 'usage impresso');
  assert.ok(!/log do run/.test(child.stdout), 'não abre log de execução p/ um --help');
  // Nenhum run no ledger = nenhum crawl começou (o bug antigo criava run + gastava LLM).
  assert.equal(stmts.listRuns.all(5).length, 0, 'nenhum run criado');
  const logsDir = path.join(process.env.NC_HOME, 'logs');
  if (existsSync(logsDir)) {
    const logs = readdirSync(logsDir).filter((f) => f.startsWith('crawl-'));
    assert.equal(logs.length, 0, `nenhum log de crawl criado (${logs.join(',')})`);
  }
});

test('-h também mostra a ajuda e sai 0 (flag curta)', () => {
  const child = run(['-h']);
  assert.equal(child.status, 0, `falhou: ${child.stderr || child.stdout}`);
  assert.match(child.stdout, /uso:/);
});

test('--version e -V imprimem a versão do package.json e saem 0', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const flag of ['--version', '-V']) {
    const child = run([flag]);
    assert.equal(child.status, 0, `${flag} falhou: ${child.stderr || child.stdout}`);
    assert.ok(child.stdout.includes(pkg.version), `${flag} imprime a versão ${pkg.version}`);
    assert.match(child.stdout, /^newsletter-crawler /, 'prefijo do nome');
  }
});

test('--version não abre log de execução nem cria run', () => {
  const child = run(['--version']);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(stmts.listRuns.all(5).length, 0, 'nenhum run criado');
  const logsDir = path.join(process.env.NC_HOME, 'logs');
  assert.ok(!existsSync(logsDir), 'diretório de logs nem criado');
});
