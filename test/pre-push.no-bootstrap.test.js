// `git push` NÃO PODE RESTAURAR O BANCO PELAS COSTAS DO USUÁRIO — e, quando o guard bloqueia, o
// hook tem de dizer QUE FOI O GUARD.
//
// O achado que originou este arquivo (validação 2026-09-05): `export` estava na allowlist do
// bootstrap (`BOOTSTRAP_COMMANDS`, src/cli-restore.js) e o `.githooks/pre-push` roda
// `node src/index.js export --format web` a CADA push. Resultado: todo `git push` com a base vazia
// disparava uma restauração completa (~21s, 15.502 artigos escritos no banco real) sem aviso prévio
// e sem ninguém pedir — aconteceu de verdade, num clone. A razão de `export` estar lá ("senão o
// hook exporta um snapshot vazio") morreu quando o guard anti-encolhimento passou a viver DENTRO do
// `exportWebSnapshot`: hoje quem barra o snapshot vazio é o guard, antes do 1º byte.
//
// Este arquivo prova as DUAS metades, com git de verdade (repo descartável + remote BARE) e a CLI
// real em subprocesso — nunca o repo nem o NC_HOME do usuário:
//   1. push com a base VAZIA => o banco continua vazio (zero bootstrap) E o push segue (fail-open);
//   2. o snapshot VAZIO não é publicado: nada é commitado, o HEAD mantém o snapshot cheio;
//   3. a mensagem do hook distingue "o GUARD bloqueou" de "o export NÃO RODOU (ambiente)";
//   4. o opt-in do ambiente (NC_ALLOW_SHRINK) CHEGA ao export como `--allow-shrink [wipe]` — com
//      ESPAÇO, a única forma que o parseFlags do projeto entende.
//
// Nada aqui importa src/: tudo roda em processos filhos com NC_HOME próprio (o único import é o
// better-sqlite3, para CONTAR as linhas do banco da sandbox em modo leitura).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { cleanup, commitSnapshot, git, makeSandbox, snapRow } from './helpers/cli-sandbox.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(REPO, '.githooks', 'pre-push');
const trash = [];
after(() => cleanup(trash));

/** Instala o hook REAL (symlink) num diretório de hooks próprio da sandbox. */
function instalaHook(dir) {
  const hooks = path.join(dir, '.hooks-teste');
  mkdirSync(hooks, { recursive: true });
  symlinkSync(HOOK, path.join(hooks, 'pre-push'));
  git(dir, ['config', 'core.hooksPath', hooks]);
  git(dir, ['config', 'user.email', 'teste@exemplo.invalido']);
  git(dir, ['config', 'user.name', 'Teste']);
}

/** Remote BARE + `git push origin main` de verdade, com o ambiente do usuário (NC_HOME isolado). */
function pushDeVerdade({ dir, home }, extraEnv = {}) {
  const bare = mkdtempSync(path.join(tmpdir(), 'nc-push-bare-'));
  trash.push(bare);
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare], { stdio: 'pipe' });
  git(dir, ['remote', 'add', 'origin', `file://${bare}`]);
  const env = {
    ...process.env,
    NC_HOME: home,
    NC_HOOK_LIVE_MS: '0', // o hook não consulta o site nos testes
    GIT_TERMINAL_PROMPT: '0',
    ...extraEnv,
  };
  // O bootstrap se desligaria sozinho sob a suíte (isUnderTest) — e aí o teste não provaria NADA.
  delete env.NODE_TEST_CONTEXT;
  delete env.NC_UNDER_TEST;
  const r = spawnSync('git', ['push', 'origin', 'main'], { cwd: dir, encoding: 'utf8', env, timeout: 180000 });
  return { ...r, out: `${r.stdout || ''}${r.stderr || ''}`, bare };
}

const artigosNoBanco = (home) => {
  const file = path.join(home, 'crawler.db');
  if (!existsSync(file)) return 0;
  const conn = new Database(file, { readonly: true });
  try {
    return conn.prepare('SELECT COUNT(*) AS c FROM articles').get().c;
  } finally {
    conn.close();
  }
};

test('git push com a base VAZIA: o banco NÃO é reescrito e o snapshot vazio NÃO é publicado', () => {
  const box = makeSandbox('nc-push-vazio-');
  trash.push(box.dir, box.home);
  commitSnapshot(box.dir, {
    generatedAt: '2026-02-02T00:00:00.000Z',
    articles: [1, 2, 3, 4].map((i) => snapRow(i, `https://ex.test/a${i}`)),
    message: 'chore(data): snapshot com 4 artigos',
  });
  instalaHook(box.dir);
  const commitsAntes = git(box.dir, ['rev-list', '--count', 'HEAD']);

  const r = pushDeVerdade(box);

  // 1. o PUSH passou (fail-open do hook: trabalho legítimo nunca trava)
  assert.equal(r.status, 0, `o push deveria seguir mesmo com o guard bloqueando: ${r.out}`);

  // 2. o BANCO continua vazio — nenhuma restauração silenciosa
  assert.equal(artigosNoBanco(box.home), 0, 'o `git push` NÃO pode repovoar o banco do usuário');
  assert.ok(!/procurando o acervo no histórico do git/.test(r.out), 'o bootstrap nem foi cogitado');
  assert.ok(!/restore: \d+ artigos repostos/.test(r.out), 'nada foi restaurado');

  // 3. o snapshot VAZIO não foi publicado: quem barrou foi o GUARD, dentro do export
  assert.match(r.out, /GUARD ANTI-ENCOLHIMENTO bloqueou o export/, 'o hook diz que foi o guard');
  assert.match(r.out, /SnapshotShrinkError/, 'e o erro do guard aparece para o usuário');
  assert.equal(git(box.dir, ['rev-list', '--count', 'HEAD']), commitsAntes, 'nenhum commit novo');
  const meta = JSON.parse(git(box.dir, ['show', 'HEAD:webapp/public/data/meta.json']));
  assert.equal(meta.totals.articles, 4, 'o snapshot commitado continua com os 4 artigos');
  assert.equal(
    git(box.dir, ['status', '--porcelain', '--', 'webapp/public/data', 'webapp/public/api/v1']),
    '',
    'árvore limpa nos diretórios do snapshot: o export não deixou resto',
  );
});

// ---- as DUAS mensagens, isoladas (repo mínimo + `src/index.js` de mentira) ----

/** Repo com o hook real e um "export" stub que faz o que o teste mandar. */
function repoComStub(stub) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nc-hook-msg-'));
  trash.push(dir);
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'teste@exemplo.invalido');
  g('config', 'user.name', 'Teste');
  g('config', 'commit.gpgsign', 'false');
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'index.js'), stub);
  writeFileSync(path.join(dir, 'package.json'), '{ "name": "fixture", "type": "module" }\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'fixture');
  return dir;
}

/** Roda o hook REAL como o git rodaria (stdin = a linha de ref do push). */
function rodaHook(dir, env = {}) {
  const r = spawnSync('bash', [HOOK], {
    cwd: dir,
    encoding: 'utf8',
    input: `refs/heads/main ${'a'.repeat(40)} refs/heads/main ${'b'.repeat(40)}\n`,
    env: { ...process.env, NC_HOOK_LIVE_MS: '0', ...env },
  });
  return { ...r, out: `${r.stdout || ''}${r.stderr || ''}` };
}

test('o hook distingue "o GUARD bloqueou" de "o export NÃO RODOU (ambiente)"', () => {
  // (a) guard: o export sai != 0 imprimindo a exceção REAL do guard (o catch de topo do index.js
  //     imprime `e.stack`, que começa pelo NOME da classe — é esse o marcador).
  const guard = repoComStub(
    "console.error('SnapshotShrinkError: publicar este snapshot APAGARIA o acervo do site: o snapshot novo tem 0 artigos');\nprocess.exit(1);\n",
  );
  const rGuard = rodaHook(guard);
  assert.equal(rGuard.status, 0, 'o push segue (fail-open)');
  assert.match(rGuard.out, /GUARD ANTI-ENCOLHIMENTO bloqueou o export/);
  assert.match(rGuard.out, /NÃO é falha de ambiente/);
  assert.match(rGuard.out, /ncrawl restore/, 'e dá a saída acionável');
  assert.ok(!/o export NÃO RODOU aqui/.test(rGuard.out), 'não culpa o ambiente');

  // (b) ambiente: o export morre por outro motivo (sem banco/dependência) — a mensagem é a outra.
  const ambiente = repoComStub("console.error('Error: Cannot find module \\'better-sqlite3\\'');\nprocess.exit(1);\n");
  const rAmb = rodaHook(ambiente);
  assert.equal(rAmb.status, 0, 'o push segue (fail-open)');
  assert.match(rAmb.out, /o export NÃO RODOU aqui \(sem node\/banco\/dependências nesta máquina\?\)/);
  assert.ok(!/GUARD ANTI-ENCOLHIMENTO/.test(rAmb.out), 'não fala em guard quando não foi o guard');
});

test('o opt-in do ambiente CHEGA ao export como `--allow-shrink [wipe]` (com ESPAÇO)', () => {
  // O stub grava o argv que recebeu: é a prova de que NC_ALLOW_SHRINK vira flag da CLI. Sem isto o
  // guard DENTRO do export bloquearia mesmo com o opt-in, e a hint do hook mentiria.
  const stub = "import { writeFileSync } from 'node:fs';\nwriteFileSync('argv.json', JSON.stringify(process.argv.slice(2)));\nprocess.exit(1);\n";
  const casos = [
    [{}, ['export', '--format', 'web']],
    [{ NC_ALLOW_SHRINK: '1' }, ['export', '--format', 'web', '--allow-shrink']],
    [{ NC_ALLOW_SHRINK: 'wipe' }, ['export', '--format', 'web', '--allow-shrink', 'wipe']],
  ];
  for (const [env, esperado] of casos) {
    const dir = repoComStub(stub);
    rodaHook(dir, env);
    const argv = JSON.parse(readFileSync(path.join(dir, 'argv.json'), 'utf8'));
    assert.deepEqual(argv, esperado, `argv com NC_ALLOW_SHRINK=${env.NC_ALLOW_SHRINK ?? '(vazio)'}`);
    rmSync(path.join(dir, 'argv.json'), { force: true });
  }
});

test('export que FALHA não desliga a última defesa: HEAD que apagaria o acervo no ar ABORTA o push', async () => {
  // O `reset` COMMITA a remoção do snapshot. Numa máquina assim o export falha (não há base) — e se
  // o hook saísse ali, o push publicaria a destruição justamente no cenário do incidente 7c24491.
  // A checagem HEAD×ar não depende do export, então ela continua rodando depois da falha.
  const dir = repoComStub("console.error('SnapshotShrinkError: base vazia');\nprocess.exit(1);\n");
  symlinkSync(path.join(REPO, 'src', 'snapshot-guard.js'), path.join(dir, 'src', 'snapshot-guard.js'));
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ totals: { articles: 13758 } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const site = `http://127.0.0.1:${server.address().port}`;
  try {
    // HEAD sem snapshot nenhum (é o que o reset deixa) + 13.758 artigos NO AR.
    // ASSÍNCRONO de propósito: o guard consulta o "site" servido por ESTE processo — um spawnSync
    // travaria o event loop, o servidor nunca responderia e o teste passaria por engano.
    const r = await new Promise((resolve) => {
      const p = spawn('bash', [HOOK], { cwd: dir, env: { ...process.env, NC_SITE_URL: site, NC_HOOK_LIVE_MS: '4000' } });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { out += d; });
      p.on('close', (status) => resolve({ status, out }));
      p.stdin.end(`refs/heads/main ${'a'.repeat(40)} refs/heads/main ${'b'.repeat(40)}\n`);
    });
    assert.equal(r.status, 1, `o push tinha de ser ABORTADO: ${r.out}`);
    assert.match(r.out, /PUSH ABORTADO/);
    assert.match(r.out, /destruiria o acervo publicado \(13758 no ar\)/);
  } finally {
    server.close();
  }
});
