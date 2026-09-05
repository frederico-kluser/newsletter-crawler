// A FRONTEIRA DO WIPE QUE NÃO PÔDE SER COMMITADA NÃO PODE FICAR EM STAGE.
//
// Achado da validação (2026-09-05): sem identidade do git (`user.email`/`user.name`), o
// `git commit` da fronteira falha — e o fail-open seguia em frente deixando TUDO EM STAGE:
// `A .nc-wipe.json` + `D webapp/public/data/*`. O próximo `git commit -m "..."` do usuário, sobre
// outro assunto qualquer, varreria a remoção do acervo publicado junto, sem ele notar; publicada
// SEM a fronteira, é o incidente 7c24491 de novo (o site perde o acervo).
//
// Escolha (e o teste é a prova): DESFAZER o stage, não só avisar. Um aviso no meio do log de um
// `reset` não impede um `git commit -a` dez minutos depois; `git reset -- <paths>` impede.
// O working tree NÃO é tocado (os arquivos seguem removidos pelo reset, o marcador segue no disco
// valendo LOCALMENTE via readWipeMarker) e o staging ALHEIO do usuário fica intacto.
//
// NC_HOME temporário ANTES do import (config.js -> db.js): o banco real nunca é aberto.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const NC_HOME_TMP = mkdtempSync(path.join(os.tmpdir(), 'nc-wipe-stage-'));
process.env.NC_HOME = NC_HOME_TMP;
writeFileSync(path.join(NC_HOME_TMP, '.env'), 'OPENROUTER_API_KEY=\nDEEPSEEK_API_KEY=\nLLM_PROVIDER=\n');

const { commitWipeBoundary, removeSiteSnapshot } = await import('../src/commands.js');
const { WIPE_MARKER_FILE } = await import('../src/restore.js');
const { db } = await import('../src/db.js');
const { setLogSink } = await import('../src/util.js');

const logs = [];
setLogSink((e) => logs.push(e));

const tmps = [NC_HOME_TMP];
after(() => {
  db.close();
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

const IDENT = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
};
const git = (dir, args, env = {}) =>
  String(
    execFileSync('git', args, {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
      env: { ...process.env, ...IDENT, GIT_TERMINAL_PROMPT: '0', ...env },
    }),
  ).trim();

const DATA = 'webapp/public/data';
const API = 'webapp/public/api/v1';

/**
 * Repo com o snapshot commitado e SEM identidade utilizável: `user.useConfigOnly=true` sem
 * `user.email` faz o `git commit` falhar de forma DETERMINÍSTICA ("no email was given and
 * auto-detection is disabled") — a auto-detecção por hostname não é confiável num teste.
 */
function repoSemIdentidade() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nc-wipe-stage-repo-'));
  tmps.push(root);
  git(root, ['init', '-b', 'main', '-q']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(path.join(root, DATA), { recursive: true });
  mkdirSync(path.join(root, API), { recursive: true });
  const dump = (o) => `${JSON.stringify(o, null, 1)}\n`;
  writeFileSync(path.join(root, DATA, 'meta.json'), dump({ schemaVersion: 1, totals: { articles: 3 } }));
  writeFileSync(path.join(root, DATA, 'articles.json'), dump([{ id: 1 }, { id: 2 }, { id: 3 }]));
  writeFileSync(path.join(root, API, 'corpus.json'), dump({ articles: [{ id: 1 }] }));
  writeFileSync(path.join(root, 'README.md'), '# repo de teste\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--no-verify', '-m', 'snapshot commitado']);
  // Só DEPOIS do commit de fixture: daqui em diante nenhum commit sem identidade passa.
  git(root, ['config', 'user.useConfigOnly', 'true']);
  return root;
}

/** Roda a fronteira com o ambiente LIMPO de identidade (o módulo herda o process.env). */
function fronteiraSemIdentidade(root, opts) {
  const salvos = {};
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) {
    salvos[k] = process.env[k];
    delete process.env[k];
  }
  const globalAntes = process.env.GIT_CONFIG_GLOBAL;
  const systemAntes = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  try {
    return commitWipeBoundary(root, opts);
  } finally {
    for (const [k, v] of Object.entries(salvos)) if (v !== undefined) process.env[k] = v;
    if (globalAntes === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = globalAntes;
    if (systemAntes === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = systemAntes;
  }
}

test('sem identidade git: a fronteira NÃO commita, DESFAZ o stage e diz como voltar', () => {
  const root = repoSemIdentidade();

  // O usuário tem trabalho ALHEIO em staging — ele não pode ser tocado pelo `git reset` da fronteira.
  writeFileSync(path.join(root, 'README.md'), '# repo de teste — editado pelo usuário\n');
  git(root, ['add', 'README.md']);

  removeSiteSnapshot(root); // git rm -r do snapshot (o que o cmdReset faz antes da fronteira)
  writeFileSync(path.join(root, WIPE_MARKER_FILE), JSON.stringify({ version: 2, wipes: [{ reason: 'reset', articles: 3 }] }));
  assert.match(git(root, ['status', '--porcelain']), /^D {2}webapp/m, 'antes da fronteira a remoção ESTÁ em stage');

  logs.length = 0;
  const out = fronteiraSemIdentidade(root);
  assert.equal(out.committed, false, 'sem identidade não há commit');
  assert.equal(out.unstaged, true, 'e o stage foi desfeito');

  // O QUE FICA EM STAGE: só o que era do usuário. A remoção do acervo saiu do índice.
  const status = git(root, ['status', '--porcelain']);
  assert.ok(status.includes('M  README.md'), `staging do usuário preservado (${JSON.stringify(status)})`);
  assert.ok(!/^D {2}webapp/m.test(status), `a remoção do snapshot NÃO pode ficar em stage (${JSON.stringify(status)})`);
  assert.match(status, /^ D webapp\/public\/data\/meta\.json$/m, 'ela vira mudança do working tree, fora do índice');
  assert.match(status, /^\?\? \.nc-wipe\.json$/m, 'e o marcador vira arquivo não-rastreado (segue valendo local)');

  // O AVISO é inequívoco e acionável.
  const aviso = logs.map((l) => l.text).join('\n');
  assert.match(aviso, /fronteira do wipe NÃO commitada/);
  assert.match(aviso, /STAGE foi DESFEITO/);
  assert.match(aviso, /git checkout -- webapp\/public\/data webapp\/public\/api\/v1/, 'diz como trazer os arquivos de volta');
  assert.match(aviso, /clone novo ressuscita o acervo apagado/, 'e por que a fronteira importa');

  // A PROVA do achado: o próximo commit do usuário NÃO leva a remoção do acervo junto.
  git(root, ['commit', '-q', '--no-verify', '-m', 'trabalho do usuário']);
  const stat = git(root, ['show', '--stat', '--format=%s', 'HEAD']);
  assert.match(stat, /README\.md/);
  assert.ok(!stat.includes('webapp/public/data'), 'a deleção do acervo publicado não entrou de carona');
  assert.match(git(root, ['ls-tree', '-r', '--name-only', 'HEAD', '--', DATA]), /articles\.json/, 'snapshot intacto no HEAD');
});

test('marcador ausente (sem fronteira possível): mesma regra — nada em stage, aviso explícito', () => {
  const root = repoSemIdentidade();
  removeSiteSnapshot(root);
  logs.length = 0;
  const out = commitWipeBoundary(root, { marker: false });
  assert.equal(out.committed, false);
  assert.equal(out.error, 'sem marcador');
  assert.equal(out.unstaged, true);
  const status = git(root, ['status', '--porcelain']);
  assert.ok(!/^D {2}webapp/m.test(status), `nada da remoção em stage (${JSON.stringify(status)})`);
  const aviso = logs.map((l) => l.text).join('\n');
  assert.match(aviso, /o marcador não pôde ser gravado/);
  assert.match(aviso, /STAGE foi DESFEITO/);
});
