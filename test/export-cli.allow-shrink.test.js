// O FIO INTEIRO do opt-in do guard, ponta a ponta: argv de verdade → parseFlags REAL (extraído de
// src/index.js) → cmdExport (src/commands.js) → exportWebSnapshot escrevendo. Existia teste
// provando que o parser entende `--allow-shrink [wipe]` e teste provando que o export honra
// `allowShrink`, mas NENHUM ligava os dois — e o fio estava solto: `cmdExport` chamava
// `exportWebSnapshot({ outDir })` sem repassar a flag, então a mensagem de bloqueio mandava repetir
// com `--allow-shrink` e repetir dava EXATAMENTE o mesmo bloqueio. Depois de qualquer redução
// intencional (`ncrawl remove <fonte>`, `purge`), `ncrawl export --format web` — e o pre-push, que
// o chama — ficavam quebrados PARA SEMPRE, sem saída pela CLI. É este teste que impede a volta.
//
// NC_HOME → tmp ANTES dos imports dinâmicos (config.js/db.js resolvem no load). O outDir é SEMPRE
// um repo git descartável dentro do tmp: `cmdExport` sem `--out` escreveria no webapp/public/data
// do REPO REAL (o acervo publicado) e sem `--out` ainda geraria a API pública. Sem LLM/rede.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-export-cli-test-'));
process.env.NC_HOME = NC_HOME_TMP;
// NC_HOME/.env vazio vence o .env do REPO (precedência shell < repo < NC_HOME): o export não usa
// LLM, mas o import de commands.js atravessa config.js — determinismo (mesmo padrão dos outros).
writeFileSync(path.join(NC_HOME_TMP, '.env'), 'OPENROUTER_API_KEY=\nDEEPSEEK_API_KEY=\nLLM_PROVIDER=\n');

const { stmts, db } = await import('../src/db.js');
const { cmdExport } = await import('../src/commands.js');
const { SnapshotShrinkError } = await import('../src/export-web.js');
const { SHRINK_OPT_IN, WIPE_OPT_IN } = await import('../src/snapshot-guard.js');

// O parseFlags REAL da CLI, extraído do próprio src/index.js (não é exportado, e importar o módulo
// dispararia o CLI). Extrair — em vez de recopiar o algoritmo — faz este teste quebrar PRIMEIRO se
// o parser mudar: é o parser que decide se `--allow-shrink wipe` vira `flags['allow-shrink']`.
const parseFlags = (() => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const inicio = src.indexOf('function parseFlags(argv) {');
  const fim = src.indexOf('\n}\n', inicio);
  assert.ok(inicio >= 0 && fim > inicio, 'não achei function parseFlags(argv) em src/index.js');
  return new Function(`${src.slice(inicio, fim + 3)}\nreturn parseFlags;`)();
})();

// ---- base local: 60 artigos (o "snapshot novo" de todos os casos) ----
// 60 sobre um acervo publicado de 100 é o caso do REVISOR: a redução LEGÍTIMA que `ncrawl remove
// <fonte>`/`purge` produzem — encolhimento normal (sobra mais de 1/10), o que `--allow-shrink`
// sozinho libera; abaixo de 1/10 o veredito vira 'wipe' e só o opt-in FORTE passa (outro arquivo).
const LOCAIS = 60;
const PUBLICADOS = 100;
const alpha = stmts.upsertSource.get({ name: 'Fonte Alpha', base_url: 'http://alpha.test', type: 'index', max_index_pages: null });
for (let n = 1; n <= LOCAIS; n += 1) {
  stmts.insertArticle.run({
    source_id: alpha.id,
    url: `http://alpha.test/a${n}`,
    title: `Artigo ${n}`,
    content: `Corpo ${n}`,
    content_hash: `hash-${n}`,
    published_at: '2026-06-20',
    run_id: null,
    kind: 'news',
    issue_url: 'http://alpha.test/issues/1',
    section: null,
    blurb: null,
    content_source: 'target',
    cleaned: 0,
    needs_enrich: 0,
  });
}

const git = (dir, args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

let seq = 0;
/** Repo descartável com um snapshot de `articles` COMMITADO (o acervo "já publicado"). */
function repoPublicado(articles) {
  const dir = path.join(NC_HOME_TMP, `repo${seq++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'guard@test.local']);
  git(dir, ['config', 'user.name', 'Guard Test']);
  const meta = { schemaVersion: 1, generatedAt: '2026-08-24T00:00:00.000Z', totals: { articles } };
  writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 1)}\n`);
  writeFileSync(
    path.join(dir, 'articles.json'),
    `${JSON.stringify(Array.from({ length: articles }, (_, i) => ({ id: i + 1 })), null, 1)}\n`,
  );
  writeFileSync(path.join(dir, 'contents.part0.json'), '{\n "1": "corpo publicado"\n}\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', `acervo ${articles}`]);
  return dir;
}

/** argv de verdade → parseFlags REAL → cmdExport. Guarda-corpo: `--out` é OBRIGATÓRIO aqui. */
function cli(...argv) {
  const { flags, rest } = parseFlags(argv);
  assert.deepEqual(rest, ['export'], 'o comando é o único posicional');
  assert.ok(flags.out, 'todo caso de teste exporta p/ um outDir temporário, nunca p/ o repo real');
  return cmdExport(flags);
}

const totalNoDisco = (dir) => JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')).totals.articles;

after(() => {
  db.close();
  rmSync(NC_HOME_TMP, { recursive: true, force: true });
});

test('sem opt-in: `export --format web` é BLOQUEADO pelo guard e a mensagem entrega a saída exata', () => {
  const dir = repoPublicado(PUBLICADOS);
  assert.throws(
    () => cli('export', '--format', 'web', '--out', dir),
    (e) => {
      assert.ok(e instanceof SnapshotShrinkError, 'erro TIPADO chega ao chamador da CLI');
      assert.equal(e.verdict.reason, 'shrink');
      assert.deepEqual(e.verdict.counts, { novo: LOCAIS, head: PUBLICADOS, live: null, baseline: PUBLICADOS });
      // A hint é COPIADA pelo usuário p/ a linha de comando: tem de citar o opt-in na forma que o
      // parseFlags entende (com ESPAÇO — `--allow-shrink=wipe` viraria uma flag literal com `=`).
      assert.ok(e.hint.includes(SHRINK_OPT_IN));
      assert.equal(e.hint.includes('='), false, 'nenhuma forma com `=` na saída acionável');
      return true;
    },
  );
  assert.equal(totalNoDisco(dir), PUBLICADOS, 'bloqueado => o snapshot publicado ficou intacto');
});

test('`--allow-shrink` (a forma da hint) chega ao guard pela CLI e o export ACONTECE', () => {
  const dir = repoPublicado(PUBLICADOS);
  cli('export', '--format', 'web', '--out', dir, ...SHRINK_OPT_IN.split(/\s+/));
  assert.equal(totalNoDisco(dir), LOCAIS, 'o snapshot MENOR foi escrito de fato');
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'articles.json'), 'utf8')).length, LOCAIS);
});

test('`--allow-shrink wipe` (com ESPAÇO) chega como a string "wipe" e também libera', () => {
  const dir = repoPublicado(PUBLICADOS);
  const { flags } = parseFlags(['export', '--format', 'web', '--out', dir, ...WIPE_OPT_IN.split(/\s+/)]);
  assert.equal(flags['allow-shrink'], 'wipe', 'o parser produz a STRING, não `true`');
  cmdExport(flags);
  assert.equal(totalNoDisco(dir), LOCAIS);
});

test('a ordem das flags não importa: opt-in ANTES do --out também chega', () => {
  const dir = repoPublicado(PUBLICADOS);
  cli('export', '--format', 'web', SHRINK_OPT_IN, '--out', dir);
  assert.equal(totalNoDisco(dir), LOCAIS);
});

test('o export bloqueado NÃO fica bloqueado p/ sempre: 2ª tentativa com o opt-in passa', () => {
  // O dia a dia depois de `ncrawl remove <fonte>`: a 1ª tentativa bate no guard, o usuário COPIA o
  // opt-in da mensagem e a 2ª passa. Era isto que estava quebrado — a 2ª dava o MESMO bloqueio.
  const dir = repoPublicado(PUBLICADOS);
  assert.throws(() => cli('export', '--format', 'web', '--out', dir), SnapshotShrinkError);
  cli('export', '--format', 'web', '--out', dir, SHRINK_OPT_IN);
  assert.equal(totalNoDisco(dir), LOCAIS);
});
