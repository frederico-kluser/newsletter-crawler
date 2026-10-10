// Cooldown de hosts mortos (src/dead-hosts.js): um host que morreu (DNS/conexão/SSL) não é
// martelado a cada run — re-tenta depois do TTL ("em falha ela volta a ser processada" continua
// verdade: nada é aposentado). O erro de cooldown é de PROPÓSITO classificado como alvo morto
// para o dispatch/audit tratarem-no como tal (ficha mantém blurb).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// CONTRATO DE ISOLAMENTO: NC_HOME tmp ANTES do 1º import que alcança config.js/db.js.
process.env.NC_HOME = mkdtempSync(path.join(tmpdir(), 'nc-deadhosts-'));
process.env.DEAD_HOST_TTL_MS = '3600000'; // 1h p/ os testes (default de produção: 24h)
after(() => rmSync(process.env.NC_HOME, { recursive: true, force: true }));
const { hostCooldownMs, noteDeadHost, resetDeadHosts, deadHostsSnapshot } = await import('../src/dead-hosts.js');
const { isDeadTargetError, fetchSmart } = await import('../src/fetch.js');
const { classifyFetchError } = await import('../src/audit.js');

test('nota de morte inicia o cooldown; expirado o TTL, volta a ser tentável', () => {
  resetDeadHosts();
  const t0 = 1_000_000;
  noteDeadHost('blog.reco.ai', new Error('getaddrinfo ENOTFOUND blog.reco.ai'), t0);
  assert.ok(hostCooldownMs('blog.reco.ai', t0 + 1000) > 0, 'em cooldown');
  assert.equal(hostCooldownMs('outro.com', t0 + 1000), 0, 'só o host morto entra em cooldown');
  assert.equal(hostCooldownMs('blog.reco.ai', t0 + 3_600_001), 0, 'TTL expirado => tenta de novo');
  const snap = deadHostsSnapshot();
  assert.equal(snap['blog.reco.ai'].fails, 1);
  assert.match(snap['blog.reco.ai'].error, /ENOTFOUND/);
});

test('persistência em NC_HOME/dead-hosts.json (cache transitório)', () => {
  resetDeadHosts();
  noteDeadHost('blog.toonk.com', new Error('boom'), 1_000_000);
  const f = path.join(process.env.NC_HOME, 'dead-hosts.json');
  assert.ok(existsSync(f), 'cache gravado');
  const saved = JSON.parse(readFileSync(f, 'utf8'));
  assert.ok(saved['blog.toonk.com'], 'host no cache');
});

test('DEAD_HOST_TTL_MS=0 desliga o cooldown (comportamento antigo: re-tenta sempre)', () => {
  resetDeadHosts();
  const antes = process.env.DEAD_HOST_TTL_MS;
  process.env.DEAD_HOST_TTL_MS = '0';
  noteDeadHost('mastro.ai', new Error('x'), 1_000_000);
  assert.equal(hostCooldownMs('mastro.ai', 1_000_001), 0, 'sem cooldown com TTL 0');
  assert.deepEqual(deadHostsSnapshot()['mastro.ai'], undefined, 'nem grava');
  process.env.DEAD_HOST_TTL_MS = antes;
});

test('fetchSmart NÃO martela um host em cooldown (sem rede) e o erro é de alvo morto', async () => {
  resetDeadHosts();
  noteDeadHost('blog.reco.ai', new Error('getaddrinfo ENOTFOUND blog.reco.ai'), Date.now());
  await assert.rejects(
    () => fetchSmart('https://blog.reco.ai/artigo', { profile: 'article' }),
    (e) => {
      assert.equal(e.code, 'DEAD_HOST_COOLDOWN');
      assert.match(e.message, /alvo morto em cooldown/);
      // Integração travada: o dispatch mantém o blurb e o audit classifica como dead-target.
      assert.equal(isDeadTargetError(e), true);
      assert.equal(classifyFetchError(e.message), 'dead-target');
      return true;
    },
  );
});

test('segunda morte do mesmo host reforça a contagem (fails++)', () => {
  resetDeadHosts();
  const t0 = 5_000_000;
  noteDeadHost('releaserun.com', new Error('connect ECONNREFUSED'), t0);
  noteDeadHost('releaserun.com', new Error('connect ECONNREFUSED'), t0 + 100);
  assert.equal(deadHostsSnapshot()['releaserun.com'].fails, 2);
});
