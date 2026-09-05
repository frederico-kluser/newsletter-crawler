// Guard anti-encolhimento DENTRO do export (src/export-web.js): o snapshot só é escrito depois que
// evaluateSnapshotChange aprova, e o baseline é o HIGH-WATER de TODAS as refs do git (não o HEAD).
// Por que o high-water: comparar com o HEAD é um ratchet — assim que um snapshot menor entra em
// HEAD (7c24491: 2866 → 0), qualquer coisa >= aquilo passa p/ sempre. Aqui a base tem 3 artigos e o
// acervo publicado (20) vive numa ref que NÃO é o HEAD (o HEAD tem 2, ou seja, "cresceu").
// NC_HOME → tmp ANTES dos imports dinâmicos (db.js resolve DB_PATH no load). Sem LLM/rede.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-export-guard-test-'));
process.env.NC_HOME = NC_HOME_TMP;

const { stmts, db } = await import('../src/db.js');
const { exportWebSnapshot, publishedHighWater, SnapshotShrinkError } = await import('../src/export-web.js');

// ---- base local: 3 artigos (o "snapshot novo" de todos os casos abaixo) ----
const alpha = stmts.upsertSource.get({ name: 'Fonte Alpha', base_url: 'http://alpha.test', type: 'index', max_index_pages: null });
for (const n of [1, 2, 3]) {
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

// ---- helpers de git (repo descartável; o outDir é a RAIZ dele p/ o pathspec ser só meta.json) ----
function git(dir, args, input) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
}

let repoSeq = 0;
function newRepo() {
  const dir = path.join(NC_HOME_TMP, `repo${repoSeq++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'guard@test.local']);
  git(dir, ['config', 'user.name', 'Guard Test']);
  return dir;
}

// Snapshot fake commitado no HEAD (meta + articles + uma parte de contents, como o export real).
function commitSnapshot(dir, articles) {
  writeSnapshot(dir, articles);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', `snapshot ${articles} artigos`]);
}

function writeSnapshot(dir, articles) {
  const meta = { schemaVersion: 1, generatedAt: new Date().toISOString(), totals: { articles } };
  writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 1)}\n`);
  const rows = Array.from({ length: articles }, (_, i) => ({ id: i + 1, title: `publicado ${i + 1}` }));
  writeFileSync(path.join(dir, 'articles.json'), `${JSON.stringify(rows, null, 1)}\n`);
  writeFileSync(path.join(dir, 'contents.part0.json'), '{\n "1": "corpo publicado"\n}\n');
}

// Commit ÓRFÃO (plumbing) alcançável só por `refs/heads/<ref>`: o acervo grande fica FORA do HEAD,
// que é exatamente o cenário que `git rev-list --all` pega e um `git show HEAD:meta.json` não.
function orphanRef(dir, ref, articles) {
  const meta = `${JSON.stringify({ schemaVersion: 1, totals: { articles } }, null, 1)}\n`;
  const blob = git(dir, ['hash-object', '-w', '--stdin'], meta).trim();
  const tree = git(dir, ['mktree'], `100644 blob ${blob}\tmeta.json\n`).trim();
  const commit = git(dir, ['commit-tree', tree, '-m', `acervo ${articles}`]).trim();
  git(dir, ['update-ref', `refs/heads/${ref}`, commit]);
}

function hashDir(dir) {
  const out = {};
  for (const f of readdirSync(dir).sort()) {
    if (f === '.git') continue;
    out[f] = createHash('sha256').update(readFileSync(path.join(dir, f))).digest('hex');
  }
  return out;
}

after(() => {
  db.close();
  rmSync(NC_HOME_TMP, { recursive: true, force: true });
});

test('high-water: o baseline vem de TODAS as refs, não do HEAD (fim do ratchet)', () => {
  const dir = newRepo();
  commitSnapshot(dir, 2); // HEAD "publicou" só 2 — o ratchet do guard antigo
  orphanRef(dir, 'acervo', 20); // o acervo de verdade (20) vive noutra ref

  assert.equal(JSON.parse(git(dir, ['show', 'HEAD:meta.json'])).totals.articles, 2, 'HEAD tem 2');
  assert.equal(publishedHighWater(dir), 20, 'o high-water enxerga a ref que não é o HEAD');

  // 3 artigos > 2 (HEAD) e < 20 (high-water): com baseline de HEAD isto passaria.
  const antes = hashDir(dir);
  assert.throws(
    () => exportWebSnapshot({ outDir: dir }),
    (e) => e instanceof SnapshotShrinkError && e.verdict.reason === 'shrink' && e.verdict.counts.baseline === 20,
  );
  assert.deepEqual(hashDir(dir), antes, 'bloqueado => nenhum arquivo do snapshot foi tocado');
});

test('bloqueio NÃO escreve: articles.json/meta.json/contents.partN seguem byte-idênticos', () => {
  const dir = newRepo();
  commitSnapshot(dir, 20);
  const antes = hashDir(dir);

  const err = (() => {
    try {
      exportWebSnapshot({ outDir: dir });
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err instanceof SnapshotShrinkError, 'erro TIPADO p/ o chamador distinguir de erro genérico');
  assert.equal(err.name, 'SnapshotShrinkError');
  assert.match(err.message, /MENOS artigos/);
  assert.ok(err.hint && err.hint.includes('--allow-shrink'), 'a hint diz o opt-in exato');
  assert.deepEqual(err.verdict.counts, { novo: 3, head: 20, live: null, baseline: 20 });

  const depois = hashDir(dir);
  assert.deepEqual(depois, antes);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'articles.json'), 'utf8')).length, 20);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')).totals.articles, 20);
});

test('o site NO AR também é baseline (o chamador passa `live`)', () => {
  const dir = path.join(NC_HOME_TMP, 'sem-git');
  mkdirSync(dir, { recursive: true });
  assert.equal(publishedHighWater(dir), null, 'fora de repo git o high-water é DESCONHECIDO');
  assert.throws(
    () => exportWebSnapshot({ outDir: dir, live: 20 }),
    (e) => e.verdict.reason === 'shrink' && e.verdict.counts.baseline === 20 && e.verdict.counts.live === 20,
  );
  assert.deepEqual(readdirSync(dir), [], 'bloqueado antes de criar qualquer arquivo');
});

test('--allow-shrink libera o encolhimento NORMAL e o export escreve de fato', () => {
  const dir = newRepo();
  commitSnapshot(dir, 20);
  const r = exportWebSnapshot({ outDir: dir, allowShrink: true });
  assert.equal(r.articles, 3);
  assert.equal(r.guard.override, true, 'o veredito volta marcado como override (o chamador loga alto)');
  assert.equal(r.guard.reason, 'override-shrink');
  const escrito = JSON.parse(readFileSync(path.join(dir, 'articles.json'), 'utf8'));
  assert.equal(escrito.length, 3);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')).totals.articles, 3);
});

test('crescer e não ter base publicada seguem passando sem opt-in', () => {
  const cresce = newRepo();
  commitSnapshot(cresce, 1);
  const r1 = exportWebSnapshot({ outDir: cresce });
  assert.equal(r1.guard.reason, 'grow');
  assert.equal(r1.guard.override, false);
  assert.equal(JSON.parse(readFileSync(path.join(cresce, 'articles.json'), 'utf8')).length, 3);

  const virgem = path.join(NC_HOME_TMP, 'primeiro-export');
  const r2 = exportWebSnapshot({ outDir: virgem });
  assert.equal(r2.guard.reason, 'no-baseline');
  assert.equal(r2.articles, 3);
});

test('re-exportar a MESMA base por cima do próprio snapshot é "same" (idempotente)', () => {
  const dir = path.join(NC_HOME_TMP, 'reexport');
  const r1 = exportWebSnapshot({ outDir: dir });
  assert.equal(r1.guard.reason, 'no-baseline');
  // agora o meta.json em disco (3 artigos) É o baseline — sem git, sem site no ar.
  const r2 = exportWebSnapshot({ outDir: dir });
  assert.equal(r2.guard.reason, 'same');
  assert.equal(r2.guard.counts.baseline, 3);
});

test('meta.json em disco entra no baseline (export legítimo ainda NÃO commitado)', () => {
  const dir = newRepo();
  commitSnapshot(dir, 1); // git conhece só 1…
  writeSnapshot(dir, 40); // …e a árvore tem um export de 40 ainda não commitado
  const antes = hashDir(dir);
  assert.throws(
    () => exportWebSnapshot({ outDir: dir }),
    (e) => e.verdict.counts.baseline === 40,
  );
  assert.deepEqual(hashDir(dir), antes, 'o export não commitado não é atropelado');
});
