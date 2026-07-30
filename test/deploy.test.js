// Deploy: os helpers PUROS (a regra de negócio do comando) sem git, sem rede e sem banco. O que
// importa fixar aqui é a DECISÃO — quando publicar, quando republicar e quando não fazer nada —
// porque é ela que separa "deu push" de "está no ar".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffIsOnlyVolatile, readSnapshotStamp, splitDirtyPaths, planDeploy, fmtElapsed,
} from '../src/deploy.js';
import { deployOutcome } from '../src/ui/runLines.js';

const META = (generatedAt, articles) =>
  JSON.stringify({ schemaVersion: 1, generatedAt, totals: { articles } }, null, 1) + '\n';

// Diff de um re-export sem dado novo: só o carimbo de hora troca.
const DIFF_VOLATIL = [
  'diff --git a/webapp/public/data/meta.json b/webapp/public/data/meta.json',
  'index dcaa9b2..2ed2585 100644',
  '--- a/webapp/public/data/meta.json',
  '+++ b/webapp/public/data/meta.json',
  '@@ -3 +3 @@',
  '- "generatedAt": "2026-07-30T01:38:22.263Z",',
  '+ "generatedAt": "2026-07-30T01:39:06.326Z",',
].join('\n');

test('diffIsOnlyVolatile: só o generatedAt mudou => não é dado novo', () => {
  assert.equal(diffIsOnlyVolatile(DIFF_VOLATIL), true);
});

test('diffIsOnlyVolatile: qualquer outra linha alterada CONTA como dado novo', () => {
  const comDado = DIFF_VOLATIL + '\n@@ -6 +6 @@\n-  "articles": 3751,\n+  "articles": 3840,';
  assert.equal(diffIsOnlyVolatile(comDado), false);
});

test('diffIsOnlyVolatile: os cabeçalhos ---/+++ não são confundidos com mudança', () => {
  // "--- a/…meta.json" começa com '-' mas é cabeçalho: sem o filtro, todo diff pareceria real.
  const soCabecalho = ['--- a/x.json', '+++ b/x.json'].join('\n');
  assert.equal(diffIsOnlyVolatile(soCabecalho), false); // nenhuma linha de conteúdo => nada mudou
});

test('diffIsOnlyVolatile: diff vazio/nulo não é "só volátil"', () => {
  for (const v of ['', null, undefined]) assert.equal(diffIsOnlyVolatile(v), false);
});

test('readSnapshotStamp: lê generatedAt + total; fail-open em lixo', () => {
  const s = readSnapshotStamp(META('2026-07-29T00:00:00.000Z', 3751));
  assert.deepEqual(s, { generatedAt: '2026-07-29T00:00:00.000Z', articles: 3751 });
  assert.equal(readSnapshotStamp('não é json'), null);
  assert.equal(readSnapshotStamp(null), null);
  assert.equal(readSnapshotStamp('{}'), null); // sem generatedAt não serve de alvo p/ o polling
  // Sem totals ainda é um alvo válido (o generatedAt é o que o polling compara).
  assert.deepEqual(readSnapshotStamp('{"generatedAt":"x"}'), { generatedAt: 'x', articles: null });
});

test('splitDirtyPaths: separa dados de código e NUNCA promove untracked', () => {
  const porcelain = [
    ' M src/commands.js',
    'M  webapp/public/data/articles.json',
    ' M webapp/public/api/v1/corpus.json',
    '?? .pi/',
    '?? .env',
    ' D webapp/src/App.jsx',
    'R  velho.js -> novo.js',
  ].join('\n');
  const { data, code, untracked } = splitDirtyPaths(porcelain);
  assert.deepEqual(data, ['webapp/public/data/articles.json', 'webapp/public/api/v1/corpus.json']);
  assert.deepEqual(code, ['src/commands.js', 'webapp/src/App.jsx', 'novo.js']);
  assert.deepEqual(untracked, ['.pi/', '.env']);
});

test('splitDirtyPaths: linha sem o espaço-de-status inicial (trim a montante) não corta o nome', () => {
  // Era um bug real: `.trim()` na saída do git virava "M src/commands.js" e o parser lia
  // "rc/commands.js". A linha é re-alinhada em vez de perder o 1º caractere do caminho.
  const { code } = splitDirtyPaths('M src/commands.js\n M src/config.js');
  assert.deepEqual(code, ['src/commands.js', 'src/config.js']);
});

test('splitDirtyPaths: entrada vazia/nula não explode', () => {
  for (const v of ['', null, undefined, '\n\n']) {
    assert.deepEqual(splitDirtyPaths(v), { data: [], code: [], untracked: [] });
  }
});

// ---- planDeploy: a decisão ----
const STAMP = { generatedAt: 'G1', articles: 100 };

test('planDeploy: dado novo publica sem forçar snapshot novo', () => {
  const p = planDeploy({ dataChanged: true, ahead: 0, live: STAMP, localStamp: STAMP, force: false });
  assert.deepEqual(p, { publish: true, refresh: false, reason: 'data' });
});

test('planDeploy: código do webapp sem dado novo publica E força snapshot novo', () => {
  // Sem refresh, o alvo do polling seria o stamp que o site JÁ serve => "no ar ✓" sem build novo.
  const p = planDeploy({ dataChanged: false, codeChanged: true, ahead: 0, live: STAMP, localStamp: STAMP, force: false });
  assert.deepEqual(p, { publish: true, refresh: true, reason: 'code' });
});

test('planDeploy: código pendente SEM --include-code não publica nada', () => {
  // codeChanged só é verdade quando o usuário opta por incluir o código.
  const p = planDeploy({ dataChanged: false, codeChanged: false, ahead: 0, live: STAMP, localStamp: STAMP, force: false });
  assert.equal(p.publish, false);
});

test('planDeploy: sem dado novo mas com commit local pendente, publica (só push)', () => {
  const p = planDeploy({ dataChanged: false, ahead: 2, live: STAMP, localStamp: STAMP, force: false });
  assert.deepEqual(p, { publish: true, refresh: false, reason: 'unpushed' });
});

test('planDeploy: tudo em dia e site servindo o mesmo snapshot => não publica', () => {
  const p = planDeploy({ dataChanged: false, ahead: 0, live: STAMP, localStamp: STAMP, force: false });
  assert.deepEqual(p, { publish: false, refresh: false, reason: 'up-to-date' });
});

test('planDeploy: site ATRASADO republica com snapshot novo (build anterior falhou)', () => {
  const live = { generatedAt: 'G0', articles: 90 };
  const p = planDeploy({ dataChanged: false, ahead: 0, live, localStamp: STAMP, force: false });
  assert.deepEqual(p, { publish: true, refresh: true, reason: 'site-behind' });
});

test('planDeploy: site ilegível não inventa deploy (fail-open p/ "nada a fazer")', () => {
  const p = planDeploy({ dataChanged: false, ahead: 0, live: null, localStamp: STAMP, force: false });
  assert.deepEqual(p, { publish: false, refresh: false, reason: 'no-change' });
});

test('planDeploy: --force sempre publica e SEMPRE gera snapshot novo', () => {
  // refresh:true é o que dá um alvo verificável ao polling (generatedAt novo no HEAD).
  const p = planDeploy({ dataChanged: false, ahead: 0, live: STAMP, localStamp: STAMP, force: true });
  assert.deepEqual(p, { publish: true, refresh: true, reason: 'force' });
});

test('fmtElapsed: segundos e minutos', () => {
  assert.equal(fmtElapsed(0), '0s');
  assert.equal(fmtElapsed(4200), '4s');
  assert.equal(fmtElapsed(59_400), '59s');
  assert.equal(fmtElapsed(90_000), '1min 30s');
  assert.equal(fmtElapsed(605_000), '10min 05s');
});

// ---- desfecho na UI: cada status tem uma mensagem distinta ----
test('deployOutcome: cada status vira um Alert próprio (nada cai no "Concluído" genérico)', () => {
  const live = deployOutcome({ status: 'live', url: 'https://x.app', articles: 3751 });
  assert.equal(live.variant, 'success');
  assert.ok(live.text.includes('https://x.app') && live.text.includes('3751'));

  assert.equal(deployOutcome({ status: 'pushed', url: 'https://x.app' }).variant, 'success');
  assert.equal(deployOutcome({ status: 'up-to-date' }).variant, 'info');
  assert.equal(deployOutcome({ status: 'dry-run' }).variant, 'info');
  assert.equal(deployOutcome({ status: 'timeout' }).variant, 'warning');

  const err = deployOutcome({ status: 'error', message: 'branch errada', hint: 'git switch main' });
  assert.equal(err.variant, 'error');
  assert.ok(err.text.includes('branch errada') && err.text.includes('git switch main'));

  assert.equal(deployOutcome(null), null);
  assert.equal(deployOutcome({}), null);
});
