// SANDBOX de CLI: um repositório git DESCARTÁVEL que é, ele mesmo, a raiz do código.
//
// Por que copiar `src/` em vez de rodar o `src/index.js` do repo: o `ROOT` do config.js vem do
// LUGAR do módulo (`fileURLToPath(import.meta.url)/..`), não do cwd — então a única forma de o
// bootstrap enxergar um histórico de mentira é o próprio código morar dentro dele. `node_modules`
// entra por symlink (copiar 500 MB por teste seria absurdo).
//
// Nada aqui importa `src/`: este helper só copia arquivos, roda `git` e faz spawn. O NC_HOME real
// do usuário nunca é alcançado — cada execução recebe um NC_HOME próprio em tmpdir.
import { spawnSync, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_REL = 'webapp/public/data';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0',
};

export function git(dir, args) {
  return String(
    execFileSync('git', args, {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV },
    }),
  ).trim();
}

/** Diretório temporário REAL (sem symlink no caminho: o ROOT do config.js é comparado por texto). */
export function tmpdir(prefix) {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/**
 * Cria a sandbox: cópia de src/ + config/ + package.json (o `"type":"module"` é obrigatório),
 * symlink de node_modules e um `git init` limpo (sem hook nenhum).
 * Retorna { dir, home } — `home` é o NC_HOME isolado desta sandbox, já com .env de chaves VAZIAS
 * (o NC_HOME/.env é o último na precedência do config.js: ele neutraliza o .env real da máquina).
 */
export function makeSandbox(prefix = 'nc-cli-') {
  const dir = tmpdir(prefix);
  cpSync(path.join(REPO, 'src'), path.join(dir, 'src'), { recursive: true });
  cpSync(path.join(REPO, 'config'), path.join(dir, 'config'), { recursive: true });
  cpSync(path.join(REPO, 'package.json'), path.join(dir, 'package.json'));
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  git(dir, ['init', '-b', 'main', '-q']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.hooksPath', '/dev/null']);
  // O CÓDIGO também é commitado: sem isso um `git clone` da sandbox (o teste de clone RASO) viria
  // sem src/ e não teria o que rodar.
  git(dir, ['add', '-A', '--', '.gitignore', 'src', 'config', 'package.json']);
  git(dir, ['commit', '-q', '-m', 'chore: codigo da sandbox']);
  const home = tmpdir(`${prefix}home-`);
  writeFileSync(path.join(home, '.env'), 'OPENROUTER_API_KEY=\nDEEPSEEK_API_KEY=\nLLM_PROVIDER=\n');
  return { dir, home };
}

/** Artigo no shape EXATO do webExportArticles (o que `export --format web` grava). */
export function snapRow(id, url, extra = {}) {
  return {
    id,
    source_id: 1,
    url,
    title: `Titulo ${id}`,
    title_pt: null,
    summary_pt: `resumo ${id}`,
    snippet: `snippet ${id}`,
    date_iso: '2026-04-01',
    kind: 'news',
    section: 'News',
    verify_status: 'ok',
    verify_notes: null,
    tags: { domain: ['web'] },
    ...extra,
  };
}

/** Grava um snapshot no layout do export (JSON.stringify(x, null, 1)) e o COMMITA. */
export function commitSnapshot(dir, { articles, generatedAt, message = 'chore(data): snapshot' }) {
  const out = path.join(dir, DATA_REL);
  mkdirSync(out, { recursive: true });
  const dump = (o) => `${JSON.stringify(o, null, 1)}\n`;
  writeFileSync(
    path.join(out, 'meta.json'),
    dump({
      schemaVersion: 1,
      generatedAt,
      totals: { articles: articles.length },
      sources: [{ id: 1, name: 'Fonte Sandbox', count: articles.length }],
    }),
  );
  writeFileSync(path.join(out, 'articles.json'), dump(articles));
  writeFileSync(
    path.join(out, 'contents.json'),
    dump(Object.fromEntries(articles.map((a) => [String(a.id), `corpo completo do artigo ${a.id} com bastante texto.`]))),
  );
  git(dir, ['add', '-f', '--', DATA_REL]);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/**
 * Roda a CLI DE VERDADE dentro da sandbox (argv real -> parseFlags real -> dispatch real).
 * `NODE_TEST_CONTEXT` é REMOVIDO do ambiente do filho de propósito: sem isso o `isUnderTest()` do
 * restore.js desligaria o bootstrap e o teste não provaria nada. É o único lugar da suíte onde a
 * proteção é levantada — e ela é levantada sobre uma sandbox, nunca sobre o repo/NC_HOME reais.
 */
export function runCli({ dir, home }, args, { env = {}, allowBootstrap = true, timeout = 120000 } = {}) {
  const childEnv = { ...process.env, NC_HOME: home, ...env };
  if (allowBootstrap) delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NC_UNDER_TEST;
  const r = spawnSync(process.execPath, [path.join(dir, 'src', 'index.js'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout,
    env: childEnv,
  });
  return { ...r, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/**
 * Clone da sandbox. `depth` > 0 produz um clone RASO (`--depth 1`), que é o caso real de um CI:
 * o working tree traz o snapshot mais novo, mas o HISTÓRICO não veio — o restore precisa degradar
 * com aviso, nunca falhar. Retorna { dir, home } (NC_HOME novo e vazio: o clone começa do zero).
 */
export function cloneSandbox({ dir }, { depth = 0, prefix = 'nc-clone-' } = {}) {
  const target = tmpdir(prefix);
  rmSync(target, { recursive: true, force: true }); // o git quer o destino inexistente ou vazio
  const args = ['clone', '-q', ...(depth > 0 ? ['--depth', String(depth)] : []), `file://${dir}`, target];
  execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV } });
  symlinkSync(path.join(REPO, 'node_modules'), path.join(target, 'node_modules'), 'dir');
  const home = tmpdir(`${prefix}home-`);
  writeFileSync(path.join(home, '.env'), 'OPENROUTER_API_KEY=\nDEEPSEEK_API_KEY=\nLLM_PROVIDER=\n');
  return { dir: realpathSync(target), home };
}

/** Remove tudo o que a sandbox criou (chame no after() do arquivo de teste). */
export function cleanup(dirs) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
