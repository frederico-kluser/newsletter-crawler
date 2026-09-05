// A FRONTEIRA DO WIPE — sem ela o `reset` está QUEBRADO.
// `cmdReset` remove o snapshot do site com `git rm`, mas `git rm` NÃO apaga o histórico — e o
// restore (src/restore.js) lê o histórico. Sem uma fronteira PUBLICADA no mesmo commit, o
// próximo restore/clone RESSUSCITA exatamente o acervo que o reset acabou de apagar.
// Este arquivo prova, num repo git de mentira (nada do repo real é lido):
//   - `.nc-wipe.json` é escrito ANTES do wipe (traz a contagem de ANTES e o `snapshotAt` do
//     snapshot que ainda estava no HEAD — depois do `git rm` ele não seria mais legível);
//   - marcador e remoção do snapshot entram no MESMO commit, e o que o usuário tinha em staging
//     NÃO entra de carona;
//   - depois disso, `restoreFromGit` NÃO ressuscita o acervo — e sem o marcador ressuscitaria
//     (o contraste é a prova de que a fronteira é quem faz o trabalho).
// NC_HOME temporário ANTES do import (config.js -> db.js): o banco real nunca é aberto.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const NC_HOME_TMP = mkdtempSync(path.join(os.tmpdir(), 'nc-wipe-marker-'));
process.env.NC_HOME = NC_HOME_TMP;
writeFileSync(path.join(NC_HOME_TMP, '.env'), 'OPENROUTER_API_KEY=\nDEEPSEEK_API_KEY=\nLLM_PROVIDER=\n');

const { cmdReset } = await import('../src/commands.js');
const { stmts, db, wipeAll } = await import('../src/db.js');
const { readWipeMarker, restoreFromGit, WIPE_MARKER_FILE } = await import('../src/restore.js');
const { setLogSink } = await import('../src/util.js');

const logs = [];
setLogSink((e) => logs.push(e));

const tmps = [NC_HOME_TMP];
after(() => {
  db.close();
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

const git = (dir, args) =>
  String(
    execFileSync('git', args, {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
        GIT_TERMINAL_PROMPT: '0',
      },
    }),
  ).trim();

const DATA = 'webapp/public/data';
const API = 'webapp/public/api/v1';
const GENERATED_AT = '2026-01-01T00:00:00.000Z';
const URLS = ['https://wipe.test/a', 'https://wipe.test/b', 'https://wipe.test/c'];

// Repo com um snapshot COMMITADO no layout do export (JSON.stringify(x, null, 1)).
function buildRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nc-wipe-repo-'));
  tmps.push(root);
  git(root, ['init', '-b', 'main', '-q']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'test']);

  const dir = path.join(root, DATA);
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(root, API), { recursive: true });
  const articles = URLS.map((url, i) => ({
    id: i + 1, source_id: 1, url,
    title: `T ${url}`, title_pt: null, summary_pt: `resumo de ${url}`,
    snippet: `snippet ${url}`, date_iso: '2026-03-01',
    kind: 'news', section: 'News', verify_status: 'ok', verify_notes: null, tags: { domain: ['web'] },
  }));
  const dump = (o) => `${JSON.stringify(o, null, 1)}\n`;
  writeFileSync(
    path.join(dir, 'meta.json'),
    dump({
      schemaVersion: 1, generatedAt: GENERATED_AT,
      totals: { articles: articles.length },
      sources: [{ id: 1, name: 'Fonte Wipe', count: articles.length }],
    }),
  );
  writeFileSync(path.join(dir, 'articles.json'), dump(articles));
  writeFileSync(path.join(dir, 'contents.json'), dump(Object.fromEntries(articles.map((a) => [a.id, `corpo de ${a.url}`]))));
  writeFileSync(path.join(root, API, 'corpus.json'), dump({ articles }));
  writeFileSync(path.join(root, 'README.md'), '# repo de teste\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--no-verify', '-m', 'snapshot commitado']);
  return root;
}

function seedDb(n) {
  const src = stmts.upsertSource.get({
    name: 'Fonte Wipe', base_url: 'https://wipe.test', type: 'listing', max_index_pages: null,
  });
  for (let i = 0; i < n; i++) {
    stmts.insertArticle.run({
      source_id: src.id, url: URLS[i] || `https://wipe.test/extra-${i}`,
      title: `T ${i}`, content: `corpo local ${i}`, content_hash: `h-${i}`,
      published_at: '2026-03-01', run_id: null, kind: 'news', issue_url: null,
      section: null, blurb: null, content_source: 'target', cleaned: 0, needs_enrich: 0,
    });
  }
}

test('P3/P4: marcador escrito ANTES do wipe, no MESMO commit da remoção do snapshot — e o restore não ressuscita', () => {
  const root = buildRepo();
  seedDb(3);
  assert.equal(stmts.countArticles.get().c, 3, 'acervo local semeado');

  // O usuário tem uma mudança ALHEIA em staging: ela NÃO pode entrar no commit da fronteira.
  writeFileSync(path.join(root, 'README.md'), '# repo de teste — editado pelo usuário\n');
  git(root, ['add', 'README.md']);

  logs.length = 0;
  const out = cmdReset({ yes: true, confirm: '3' }, { root });

  // ---- P3: o conteúdo do marcador ----
  const markerPath = path.join(root, WIPE_MARKER_FILE);
  const raw = readFileSync(markerPath, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.wipes.length, 1);
  const entry = parsed.wipes[0];
  assert.equal(entry.reason, 'reset');
  assert.equal(entry.articles, 3, 'a contagem é a de ANTES do wipe (prova de que foi escrito antes)');
  assert.equal(
    entry.snapshotAt,
    GENERATED_AT,
    'o snapshotAt veio do meta.json AINDA commitado no HEAD — depois do git rm não seria legível',
  );
  assert.match(String(entry.commit), /^[0-9a-f]{40}$/, 'ancorado no commit que estava no HEAD');
  assert.equal(stmts.countArticles.get().c, 0, 'e o wipe aconteceu de verdade');

  // ---- P3: o MESMO commit carrega marcador + remoção do snapshot ----
  assert.equal(out.boundary.committed, true, 'a fronteira foi commitada');
  const stat = git(root, ['show', '--stat', '--format=%s', 'HEAD']);
  assert.match(stat, /\.nc-wipe\.json/, 'o marcador está no commit');
  assert.match(stat, /webapp\/public\/data\/articles\.json/, 'a remoção do snapshot está no MESMO commit');
  assert.match(stat, /webapp\/public\/api\/v1\/corpus\.json/, 'e a API pública também');
  assert.ok(!stat.includes('README.md'), 'o que o usuário tinha em staging NÃO entrou de carona');
  const status = git(root, ['status', '--porcelain']);
  assert.equal(status, 'M  README.md', `staging do usuário preservado (git status: ${JSON.stringify(status)})`);
  assert.equal(git(root, ['ls-files', '--', DATA, API]), '', 'snapshot fora do índice');
  assert.equal(git(root, ['ls-files', '--', WIPE_MARKER_FILE]), WIPE_MARKER_FILE, 'marcador rastreado');

  // O marcador é lido do working tree E do HEAD (readWipeMarker) — a fronteira viaja com o repo.
  const marker = readWipeMarker(root);
  assert.equal(marker.entries.length, 1);
  assert.equal(marker.entries[0].articles, 3);

  // ---- P4: o restore NÃO ressuscita o que o reset apagou ----
  const comMarcador = restoreFromGit({ root });
  assert.equal(comMarcador.selected, 0, 'nenhum registro selecionado: a fronteira cortou o histórico');
  assert.equal(comMarcador.inserted, 0, 'nada inserido');
  assert.equal(stmts.countArticles.get().c, 0, 'o acervo apagado continua apagado');

  // Contraste: SEM a fronteira (marker: null) o mesmo histórico ressuscitaria os 3 artigos —
  // é exatamente o bug que o marcador conserta.
  const semMarcador = restoreFromGit({ root, marker: null });
  assert.equal(semMarcador.inserted, 3, 'sem marcador o histórico ressuscita o acervo');
  assert.equal(stmts.countArticles.get().c, 3);

  wipeAll(); // limpa o efeito do contraste p/ o próximo teste começar do zero
  assert.ok(
    logs.some((l) => l.text.includes('marcador de wipe gravado')),
    'o usuário é informado de que a fronteira foi publicada',
  );
});

test('marcador ACUMULA (cada wipe é uma fronteira) e o reset fora de repo git não trava', () => {
  const root = buildRepo();
  seedDb(2);
  cmdReset({ yes: true, confirm: '2' }, { root });
  seedDb(1);
  cmdReset({ yes: true, confirm: '1' }, { root });
  const parsed = JSON.parse(readFileSync(path.join(root, WIPE_MARKER_FILE), 'utf8'));
  assert.equal(parsed.wipes.length, 2, 'as duas fronteiras ficam registradas (o histórico de wipes é preservado)');
  assert.deepEqual(parsed.wipes.map((w) => w.articles), [2, 1]);

  // Fora de repo git (banco standalone): o marcador é escrito, nada é commitado, nada estoura.
  const semGit = mkdtempSync(path.join(os.tmpdir(), 'nc-wipe-nogit-'));
  tmps.push(semGit);
  seedDb(1);
  const out = cmdReset({ yes: true, confirm: '1' }, { root: semGit });
  assert.equal(out.boundary.mode, 'fs');
  assert.equal(out.boundary.committed, false);
  const solto = JSON.parse(readFileSync(path.join(semGit, WIPE_MARKER_FILE), 'utf8'));
  assert.equal(solto.wipes[0].articles, 1);
  assert.equal(solto.wipes[0].commit, null, 'sem git não há sha — o marcador vale localmente mesmo assim');
});
