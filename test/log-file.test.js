// Log persistente por processo (util.js openLogFile): NC_HOME/logs/<cmd>-<ts>-<pid>.log +
// symlink latest.log, com FLUSH IMEDIATO (writeSync) — a linha aparece no arquivo na hora, sem
// nenhum flush explícito (o que um `tail -f` precisa p/ enxergar ao vivo). O sink da TUI
// (setLogSink) continua recebendo {level, text} SEM timestamp — contrato intacto.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// NC_HOME temporário ANTES do import (util lê process.env.NC_HOME no call-time, mas o padrão do
// repo é setar antes de importar qualquer módulo de src/).
process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-logfile-'));
const { openLogFile, logFilePath, closeLogFile, log, warn, errorLog, setLogSink, hasLogSink } =
  await import('../src/util.js');

after(() => {
  closeLogFile();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

test('openLogFile cria logs/<cmd>.log + latest.log e todo o log cai no arquivo com flush imediato', () => {
  const file = openLogFile({ command: 'crawl' });
  assert.ok(file, 'arquivo de log criado');
  assert.ok(file.startsWith(path.join(process.env.NC_HOME, 'logs', 'crawl-')), `nome com o comando: ${file}`);
  assert.equal(logFilePath(), file, 'logFilePath() devolve o caminho ativo');

  const dir = path.join(process.env.NC_HOME, 'logs');
  const latest = path.join(dir, 'latest.log');
  assert.ok(existsSync(latest), 'latest.log existe');
  assert.equal(readlinkSync(latest), path.basename(file), 'latest.log aponta p/ o arquivo do processo');

  log('linha um');
  warn('cuidado aqui');
  errorLog('falhou de vez');
  // FLUSH IMEDIATO: sem flush/close, a linha JÁ está no arquivo (writeSync direto no fd).
  const content = readFileSync(file, 'utf8');
  assert.ok(content.includes('linha um'), 'log() gravado');
  assert.ok(content.includes('WARN cuidado aqui'), 'warn gravado com marcador greppável');
  assert.ok(content.includes('ERROR falhou de vez'), 'errorLog gravado com marcador greppável');
  assert.match(content, /\[\d{4}-\d{2}-\d{2}T/, 'timestamp ISO por linha');
});

test('sink da TUI segue recebendo {level, text} SEM timestamp; o arquivo recebe a mesma linha', () => {
  const got = [];
  setLogSink((e) => got.push(e));
  try {
    assert.ok(hasLogSink(), 'hasLogSink() true com sink setado');
    log('pro sink');
    assert.equal(got.length, 1, 'uma linha p/ o sink');
    assert.equal(got[0].level, 'log');
    assert.equal(got[0].text, 'pro sink', 'texto SEM timestamp — contrato do RunView intacto');
    // A linha com timestamp foi pro ARQUIVO na mesma chamada.
    assert.ok(
      readFileSync(logFilePath(), 'utf8').includes('pro sink'),
      'linha gravada no arquivo com o sink ativo',
    );
  } finally {
    setLogSink(null);
  }
  assert.ok(!hasLogSink(), 'hasLogSink() false após setLogSink(null)');
});

test('objeto no log vira JSON no arquivo (nunca "[object Object]") e latest.log segue a última', () => {
  const file = openLogFile({ command: 'status' }); // troca de arquivo (idempotente)
  log('detalhe', { a: 1, b: [2] });
  const content = readFileSync(file, 'utf8');
  assert.ok(content.includes('{"a":1,"b":[2]}'), 'objeto serializado como JSON');
  const latest = path.join(process.env.NC_HOME, 'logs', 'latest.log');
  assert.equal(readlinkSync(latest), path.basename(file), 'latest.log agora aponta p/ o novo arquivo');
  const all = readdirSync(path.join(process.env.NC_HOME, 'logs'));
  assert.equal(all.filter((f) => f.endsWith('.log') && f !== 'latest.log').length, 2, 'um arquivo datado por openLogFile');
});

test('closeLogFile fecha e zera o logFilePath (fail-open em arquivosystem ruim)', () => {
  closeLogFile();
  assert.equal(logFilePath(), null, 'sem arquivo ativo');
  log('sem arquivo — não lança');
});
