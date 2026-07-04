// normalizeUrl: PRESERVA "www." (www.host e host podem ser servidores diferentes — vários
// Substack de domínio próprio não têm DNS no ápice; colapsar www->ápice gerava URL morta) e
// mantém as demais normalizações (hash, barra final, params de tracking, ordenação de query).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl } from '../src/util.js';

test('preserva www. (regressão: NÃO colapsar para o ápice)', () => {
  assert.equal(normalizeUrl('https://www.deeplearningweekly.com/archive'), 'https://www.deeplearningweekly.com/archive');
  assert.equal(normalizeUrl('https://www.deeplearningweekly.com/p/issue-462'), 'https://www.deeplearningweekly.com/p/issue-462');
  // host sem www continua sem www (não inventa)
  assert.equal(normalizeUrl('https://nodeweekly.com/issues'), 'https://nodeweekly.com/issues');
});

test('demais normalizações seguem valendo (hash, barra final, tracking, ordenação)', () => {
  assert.equal(normalizeUrl('https://www.x.com/a/#frag'), 'https://www.x.com/a');
  assert.equal(normalizeUrl('https://www.x.com/a/'), 'https://www.x.com/a');
  assert.equal(normalizeUrl('https://www.x.com/a?utm_source=nl&b=2&a=1'), 'https://www.x.com/a?a=1&b=2');
});

test('resolve relativo contra base e devolve null p/ inválido', () => {
  assert.equal(normalizeUrl('/p/123', 'https://www.x.com/archive'), 'https://www.x.com/p/123');
  assert.equal(normalizeUrl(''), null);
  assert.equal(normalizeUrl('not a url'), null);
});
