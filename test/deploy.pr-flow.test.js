// Fluxo de publicação por PR do deploy (a `main` é cofre: o ruleset exige PR + squash). O que se
// fixa aqui é a COREOGRAFIA git+gh: commit nasce numa branch efémera (nunca na main local), o PR
// sai com título Conventional, o merge é squash com delete-branch e a main local só faz
// fast-forward. Sem rede e sem repo de verdade: `git`/`gh`/export entram por injeção.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// CONTRATO DE ISOLAMENTO: NC_HOME tmp ANTES do 1º import que alcança config.js/db.js.
process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-deploy-pr-'));
after(() => rmSync(process.env.NC_HOME, { recursive: true, force: true }));
const { runDeploy, deployBranchName, DeployError } = await import('../src/deploy.js');

const META = (generatedAt, articles) =>
  JSON.stringify({ schemaVersion: 1, generatedAt, totals: { articles } }, null, 1) + '\n';

const ROOT_FAKE = '/repo';

/** Costura de git scriptada: responde por subcomando e REPROVA chamada inesperada. */
function mkGit(handlers) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const key = args.join(' ');
    for (const [re, out] of handlers) {
      if (re.test(key)) return typeof out === 'function' ? out(args) : out;
    }
    throw new Error(`chamada de git inesperada no teste: ${key}`);
  };
  return { run, calls };
}

const HANDLERS_PADRAO = [
  [/^rev-parse --show-toplevel$/, ROOT_FAKE],
  [/^rev-parse --abbrev-ref HEAD$/, 'main'],
  [/^remote$/, 'origin'],
  [/^remote get-url origin$/, 'git@github.com:x/y.git'], // SSH: pula o ensureGithubGitAuth
  [/^status --porcelain$/, ''],
  [/^fetch --quiet origin main$/, 'ok'],
  [/^rev-list --left-right --count origin\/main\.\.\.HEAD$/, '0\t0'],
  [/^show HEAD:webapp\/public\/data\/meta\.json$/, META('2026-07-30T00:00:00.000Z', 3751)],
  [/^status --porcelain -- webapp\/public\/data webapp\/public\/api\/v1$/, ' M webapp/public/data/articles.json'],
  [/^switch -c deploy\//, ''],
  [/^add -- /, ''],
  [/^commit --no-verify /, ''],
  [/^rev-parse --short HEAD$/, 'abc1234'],
  [/^push --no-verify origin HEAD:refs\/heads\/deploy\//, ''],
  [/^rev-parse HEAD$/, 'abc1234def'],
  [/^switch main$/, ''],
  [/^merge --ff-only origin\/main$/, 'Fast-forward'],
];

const DEPS_PADRAO = (gitRun, ghRun) => ({
  git: gitRun,
  gh: ghRun,
  exportWeb: () => ({ articles: 3800, bytes: 1000 }),
  exportApi: () => ({ bytes: 10 }),
  fetchLive: async () => ({ generatedAt: '2026-07-29T00:00:00.000Z', articles: 3751, bytes: 500 }),
});

test('deployBranchName: formato legível e estável', () => {
  const b = deployBranchName(new Date('2026-10-09T10:45:01.234Z'));
  assert.equal(b, 'deploy/data-2026-10-09T10-45-01');
  assert.match(deployBranchName(), /^deploy\/data-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
});

test('runDeploy: dado novo → branch efémera + PR + squash merge + ff da main', async () => {
  const { run: gitRun, calls } = mkGit(HANDLERS_PADRAO);
  const ghCalls = [];
  const ghRun = (args) => {
    ghCalls.push(args);
    const key = args.join(' ');
    if (key === '--version') return 'gh version 2.98.0';
    if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/x/y/pull/7';
    if (args[0] === 'pr' && args[1] === 'merge') return '';
    if (args[0] === 'api') return 'deadbeefcafe0123456789';
    throw new Error(`chamada de gh inesperada no teste: ${key}`);
  };

  const res = await runDeploy({ 'no-wait': true }, DEPS_PADRAO(gitRun, ghRun));
  assert.equal(res.status, 'pushed');
  assert.equal(res.sha, 'deadbeefcafe0123456789', 'sha = merge_commit_sha do PR (o que a Vercel constrói)');
  assert.equal(res.articles, 3800);

  // git: commit nasce na branch efémera, o push vai para ela e a main só é sincronizada no fim.
  const branch = calls.find((a) => a[0] === 'switch' && a[1] === '-c')?.[2];
  assert.match(branch, /^deploy\/data-/);
  const push = calls.find((a) => a[0] === 'push');
  assert.deepEqual(push.slice(0, 3), ['push', '--no-verify', 'origin']);
  assert.equal(push[3], `HEAD:refs/heads/${branch}`);
  const commit = calls.find((a) => a[0] === 'commit');
  assert.match(commit[3], /^chore\(data\): atualiza snapshot do webapp \+ API pública/, 'conventional: vira a mensagem do squash');
  const finalSwitch = calls.filter((a) => a[0] === 'switch').at(-1);
  assert.deepEqual(finalSwitch, ['switch', 'main'], 'volta à main local');
  assert.ok(calls.some((a) => a[0] === 'merge' && a[1] === '--ff-only'), 'main local fast-forwarda até o squash');

  // gh: PR para a main a partir da branch efémera, título Conventional, squash + delete-branch.
  const create = ghCalls.find((a) => a[0] === 'pr' && a[1] === 'create');
  const flag = (n) => create[create.indexOf(n) + 1];
  assert.equal(flag('--base'), 'main');
  assert.equal(flag('--head'), branch);
  assert.match(flag('--title'), /^chore\(data\): /);
  const merge = ghCalls.find((a) => a[0] === 'pr' && a[1] === 'merge');
  assert.ok(merge.includes('--squash') && merge.includes('--delete-branch'), 'squash merge e branch apagada');
  assert.ok(merge.includes('7'), 'merge pelo NÚMERO do PR');
});

test('runDeploy: falha no PR devolve hint com a branch onde o snapshot ficou', async () => {
  const { run: gitRun } = mkGit(HANDLERS_PADRAO);
  const ghRun = (args) => {
    if (args.join(' ') === '--version') return 'gh version 2.98.0';
    if (args[0] === 'pr' && args[1] === 'create') throw new Error('HTTP 403 (resource not accessible)');
    throw new Error(`chamada de gh inesperada: ${args.join(' ')}`);
  };
  await assert.rejects(
    () => runDeploy({ 'no-wait': true }, DEPS_PADRAO(gitRun, ghRun)),
    (e) => {
      assert.ok(e instanceof DeployError);
      assert.match(e.hint, /fiquei na branch deploy\/data-/, 'o hint aponta a branch com o commit');
      assert.match(e.hint, /gh pr merge --squash/, '…e como completar à mão');
      return true;
    },
  );
});

test('runDeploy: sem gh CLI aborta ANTES de exportar', async () => {
  const { run: gitRun, calls } = mkGit(HANDLERS_PADRAO);
  let exported = false;
  const deps = DEPS_PADRAO(gitRun, () => null); // gh inexistente: --version → null (allowFail)
  deps.exportWeb = () => { exported = true; return { articles: 1, bytes: 1 }; };
  await assert.rejects(
    () => runDeploy({ 'no-wait': true }, deps),
    (e) => e instanceof DeployError && /gh CLI não encontrado/.test(e.message),
  );
  assert.equal(exported, false, 'nada foi exportado/escrito antes do gate do gh');
  assert.ok(!calls.some((a) => a[0] === 'commit'), 'nenhum commit criado');
});
