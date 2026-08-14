// Eval do keys.js: upsertEnvVar grava/atualiza a chave num .env preservando outras linhas (usado
// pelo `ncrawl key set`), maskKey mascara para log, e os PROBES por provedor (dispatcher) — a
// DeepSeek contra um servidor HTTP LOCAL (o baseURL é lido do ENV em call-time, então dá p/
// apontar; 200 = chave válida, 401 = errada) e o short-circuit de chave vazia da OpenRouter
// (sem rede). Usa arquivo TEMP; não toca no NC_HOME real. npm test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {
  upsertEnvVar, maskKey, probeDeepSeekKey, probeProviderKey, providerInfoFor,
} from '../src/keys.js';

const tmp = path.join(os.tmpdir(), `nc-env-${process.pid}.env`);
after(() => rmSync(tmp, { force: true }));

// ---- servidor local do probe da DeepSeek (GET /models: 200 com chave certa, 401 com errada) ----
const dsServer = http.createServer((req, res) => {
  if (req.url === '/models' && req.headers.authorization === 'Bearer sk-ds-ok') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"object":"list","data":[]}');
  } else {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"Authentication Fails"}}');
  }
});
await new Promise((r) => dsServer.listen(0, '127.0.0.1', r));
const DS_URL = `http://127.0.0.1:${dsServer.address().port}`;
const ORIG_DS_BASE = process.env.DEEPSEEK_BASE_URL; // restaurar no fim (máquina pode ter setada)

after(() => {
  if (ORIG_DS_BASE === undefined) delete process.env.DEEPSEEK_BASE_URL;
  else process.env.DEEPSEEK_BASE_URL = ORIG_DS_BASE;
  dsServer.close(); // idempotente
});

test('upsertEnvVar: cria o arquivo com a chave', () => {
  const r = upsertEnvVar('OPENROUTER_API_KEY', 'sk-or-abc', tmp);
  assert.equal(r.updated, false);
  assert.match(readFileSync(tmp, 'utf8'), /^OPENROUTER_API_KEY=sk-or-abc$/m);
});

test('upsertEnvVar: atualiza a chave existente sem duplicar e preserva outras linhas', () => {
  writeFileSync(tmp, 'FOO=bar\nOPENROUTER_API_KEY=old\nBAZ=qux\n');
  const r = upsertEnvVar('OPENROUTER_API_KEY', 'new', tmp);
  assert.equal(r.updated, true);
  const txt = readFileSync(tmp, 'utf8');
  assert.match(txt, /^FOO=bar$/m, 'preserva linhas anteriores');
  assert.match(txt, /^BAZ=qux$/m, 'preserva linhas posteriores');
  assert.match(txt, /^OPENROUTER_API_KEY=new$/m, 'atualiza o valor');
  assert.equal((txt.match(/^OPENROUTER_API_KEY=/gm) || []).length, 1, 'não duplica a chave');
});

test('maskKey: mantém prefixo + sufixo e trata vazio', () => {
  assert.equal(maskKey('sk-or-v1-abcdef1234'), 'sk-or-v1…1234');
  assert.equal(maskKey(''), '(vazia)');
  assert.equal(maskKey('curta'), 'cu…');
});

test('upsertEnvVar por provider: DEEPSEEK_API_KEY convive com OPENROUTER_API_KEY no mesmo .env', () => {
  writeFileSync(tmp, 'OPENROUTER_API_KEY=sk-or-v1-antiga\nFOO=bar\n');
  const r = upsertEnvVar('DEEPSEEK_API_KEY', 'sk-ds-v1-nova', tmp);
  assert.equal(r.updated, false, 'var nova = cria (não atualiza)');
  const txt = readFileSync(tmp, 'utf8');
  assert.match(txt, /^OPENROUTER_API_KEY=sk-or-v1-antiga$/m, 'chave do outro provider preservada');
  assert.match(txt, /^DEEPSEEK_API_KEY=sk-ds-v1-nova$/m, 'var do provider gravada');
  assert.equal((txt.match(/^DEEPSEEK_API_KEY=/gm) || []).length, 1, 'sem duplicar');
});

test('probeDeepSeekKey: 200 = válida, 401 = chave errada (GET /models no baseURL)', async () => {
  process.env.DEEPSEEK_BASE_URL = DS_URL;
  const ok = await probeDeepSeekKey('sk-ds-ok');
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 200);
  const ruim = await probeDeepSeekKey('sk-ds-errada');
  assert.equal(ruim.ok, false);
  assert.equal(ruim.status, 401);
});

test('probeDeepSeekKey: chave vazia e erro de rede NÃO lançam — {ok:false, status:0, reason}', async () => {
  const vazia = await probeDeepSeekKey('');
  assert.deepEqual(vazia, { ok: false, status: 0, reason: 'chave vazia' });
  process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:1'; // porta fechada: conexão recusada na hora
  const net = await probeDeepSeekKey('sk-x');
  assert.equal(net.ok, false);
  assert.equal(net.status, 0);
  assert.ok(net.reason, 'motivo presente (fail-open, sem lançar)');
  process.env.DEEPSEEK_BASE_URL = DS_URL; // volta p/ o servidor local
});

test('probeProviderKey (dispatcher): roteia p/ a DeepSeek pelo provider e curto-circuita vazias', async () => {
  // deepseek -> servidor local (via baseURL do ENV em call-time)
  const ok = await probeProviderKey('sk-ds-ok', 'deepseek');
  assert.equal(ok.ok, true);
  // chave vazia NUNCA toca a rede (qualquer provider) — short-circuit antes do got
  assert.deepEqual(await probeProviderKey('', 'deepseek'), { ok: false, status: 0, reason: 'chave vazia' });
  assert.deepEqual(await probeProviderKey('', 'openrouter'), { ok: false, status: 0, reason: 'chave vazia' });
  // provider inválido/ausente clampa p/ openrouter (mesma regra do config.js)
  assert.equal(providerInfoFor('qualquer-coisa').keyVar, 'OPENROUTER_API_KEY');
  assert.equal(providerInfoFor(undefined).name, 'OpenRouter');
});

test('providerInfoFor: descritores por provedor (keyVar/baseURL) espelham o config', () => {
  assert.deepEqual(providerInfoFor('openrouter'), {
    name: 'OpenRouter',
    keyVar: 'OPENROUTER_API_KEY',
    baseURL: 'https://openrouter.ai/api/v1',
  });
  // o baseURL da DeepSeek é lido do ENV em call-time: sem env, o default do config.
  const saved = process.env.DEEPSEEK_BASE_URL;
  delete process.env.DEEPSEEK_BASE_URL;
  try {
    assert.equal(providerInfoFor('deepseek').baseURL, 'https://api.deepseek.com', 'default sem env');
  } finally {
    if (saved !== undefined) process.env.DEEPSEEK_BASE_URL = saved;
  }
  const ds = providerInfoFor('deepseek');
  assert.equal(ds.name, 'DeepSeek');
  assert.equal(ds.keyVar, 'DEEPSEEK_API_KEY');
});
