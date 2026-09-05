// Eval do leitor de RAM do governador: parse de /proc/meminfo por fixture (MemAvailable é o
// sinal certo — conta page cache recuperável) e sanidade do readMemInfo real. npm test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// NC_HOME temporário ANTES do import (governor.js -> config.js): no load, config.js cria/semeia o
// NC_HOME REAL do usuário e carrega o .env dele. Import dinâmico porque o `import`
// estático é IÇADO — rodaria antes desta linha.
process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-governor-meminfo-'));
after(() => rmSync(process.env.NC_HOME, { recursive: true, force: true }));
const { parseMemInfo, readMemInfo } = await import('../src/governor.js');

const FIXTURE = `MemTotal:       32756384 kB
MemFree:         3467788 kB
MemAvailable:   14328212 kB
Buffers:          745124 kB
Cached:         11967520 kB
`;

test('parseMemInfo: extrai MemTotal/MemAvailable em bytes', () => {
  const m = parseMemInfo(FIXTURE);
  assert.equal(m.totalBytes, 32756384 * 1024);
  assert.equal(m.availableBytes, 14328212 * 1024);
});

test('parseMemInfo: null quando MemAvailable falta (kernel antigo) ou entrada vazia', () => {
  assert.equal(parseMemInfo('MemTotal: 1000 kB\nMemFree: 10 kB\n'), null);
  assert.equal(parseMemInfo(''), null);
  assert.equal(parseMemInfo(null), null);
});

test('readMemInfo: retorna números plausíveis nesta máquina', () => {
  const m = readMemInfo();
  assert.ok(m.totalBytes > 0, 'total > 0');
  assert.ok(m.availableBytes >= 0, 'available >= 0');
  assert.ok(m.availableBytes <= m.totalBytes, 'available <= total');
});
