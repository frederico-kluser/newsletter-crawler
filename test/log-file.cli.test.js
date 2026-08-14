// e2e do log persistente no CLI REAL (subprocesso): `node src/index.js status` anuncia
// "log do run: <caminho>" no início e grava TUDO em NC_HOME/logs/latest.log — a prova de que o
// `tail -f NC_HOME/logs/latest.log` acompanha uma execução real, mesmo com stdout buferizado.
// NC_HOME tmp + .env semeado com chaves VAZIAS (padrão do commands.reextract.test.js: o
// NC_HOME/.env é o ÚLTIMO na precedência do config.js, então o vazio vence o ROOT/.env real).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-logcli-'));
writeFileSync(
  path.join(process.env.NC_HOME, '.env'),
  'OPENROUTER_API_KEY=\nDEEPSEEK_API_KEY=\nLLM_PROVIDER=\n',
);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

after(() => {
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

const run = (args) =>
  spawnSync(process.execPath, ['src/index.js', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env },
  });

test('status em subprocesso: anuncia "log do run:" e o latest.log recebe o status com flush', () => {
  const child = run(['status']);
  assert.equal(child.status, 0, `falhou: ${child.stderr || child.stdout}`);
  const m = child.stdout.match(/log do run: (.+)/);
  assert.ok(m, 'anúncio do caminho no início do stdout');
  assert.ok(m[1].includes(`${process.env.NC_HOME}${path.sep}logs${path.sep}status-`), `caminho em NC_HOME/logs: ${m[1]}`);
  assert.ok(m[1].endsWith('.log'), 'arquivo datado .log');

  const latest = path.join(process.env.NC_HOME, 'logs', 'latest.log');
  assert.ok(existsSync(latest), 'latest.log existe após a execução');
  assert.equal(readlinkSync(latest), path.basename(m[1]), 'latest.log aponta p/ o log do subprocesso');

  // Tudo que o processo logou está NO ARQUIVO (o stdout do pipe do npm podia buferizar; o
  // arquivo é escrito com writeSync direto).
  const content = readFileSync(latest, 'utf8');
  assert.ok(content.includes('log do run:'), 'o anúncio também está no arquivo');
  assert.ok(content.includes('— status —'), 'status gravado');
  assert.ok(content.includes('sources:'), 'contagens gravadas');
  assert.match(content, /\[\d{4}-\d{2}-\d{2}T/, 'timestamps ISO no arquivo');
});

test('comando desconhecido NÃO abre log de execução', () => {
  const child = run(['nao-existe']);
  assert.notEqual(child.status, 0, 'comando desconhecido sai != 0');
  assert.match(child.stdout + child.stderr, /comando desconhecido/);
  const logsDir = path.join(process.env.NC_HOME, 'logs');
  const files = existsSync(logsDir)
    ? readdirSync(logsDir).filter((f) => f !== 'latest.log')
    : [];
  assert.ok(files.every((f) => f.startsWith('status-')), `só logs do teste anterior (${files.join(',')})`);
});
