// Eval do leitor de RAM do governador: parse de /proc/meminfo por fixture (MemAvailable é o
// sinal certo — conta page cache recuperável) e sanidade do readMemInfo real. npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMemInfo, readMemInfo } from '../src/governor.js';

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
