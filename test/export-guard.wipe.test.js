// O incidente 2026-08-24 (commit 7c24491) reproduzido no export: base local VAZIA (0 artigos) por
// cima de 2866 commitados e 2866 no ar. Arquivo separado do export-guard.test.js porque o cenário
// exige um SQLite sem nenhum artigo — e o NC_HOME/db nasce uma vez por processo de teste.
// A asserção que importa: bloqueado, os JSONs do snapshot ficam BYTE-IDÊNTICOS na árvore (um
// bloqueio depois da escrita deixaria os arquivos já esvaziados, prontos p/ o próximo `git add`).
// Sem LLM/rede.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-export-guard-wipe-test-'));
process.env.NC_HOME = NC_HOME_TMP;
// NC_HOME/.env vazio vence o .env do REPO (shell < repo < NC_HOME): o import de commands.js
// atravessa config.js e o export não usa LLM — determinismo, mesmo padrão dos outros testes.
writeFileSync(path.join(NC_HOME_TMP, '.env'), 'OPENROUTER_API_KEY=\nDEEPSEEK_API_KEY=\nLLM_PROVIDER=\n');

const { db } = await import('../src/db.js'); // base VAZIA de propósito: nenhum artigo semeado
const { exportWebSnapshot, SnapshotShrinkError } = await import('../src/export-web.js');
const { cmdExport } = await import('../src/commands.js');
const { WIPE_OPT_IN, SHRINK_OPT_IN } = await import('../src/snapshot-guard.js');

// parseFlags REAL da CLI (extraído de src/index.js, que não o exporta): o teste ponta a ponta do
// opt-in FORTE precisa do parser de verdade — é ele que transforma `--allow-shrink wipe` (com
// ESPAÇO) na string 'wipe' que o guard entende.
const parseFlags = (() => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const inicio = src.indexOf('function parseFlags(argv) {');
  const fim = src.indexOf('\n}\n', inicio);
  assert.ok(inicio >= 0 && fim > inicio, 'não achei function parseFlags(argv) em src/index.js');
  return new Function(`${src.slice(inicio, fim + 3)}\nreturn parseFlags;`)();
})();

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

let seq = 0;
function repoComAcervo(articles) {
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

test('0 artigos por cima de 2866 (o 7c24491) => BLOQUEIA e não escreve um byte', () => {
  const dir = repoComAcervo(2866);
  const antes = hashDir(dir);

  assert.throws(
    () => exportWebSnapshot({ outDir: dir, live: 2866 }),
    (e) => {
      assert.ok(e instanceof SnapshotShrinkError);
      assert.equal(e.verdict.reason, 'wipe');
      assert.equal(e.verdict.risk, 'wipe');
      assert.deepEqual(e.verdict.counts, { novo: 0, head: 2866, live: 2866, baseline: 2866 });
      assert.match(e.message, /APAGARIA o acervo/);
      assert.ok(e.hint.includes(WIPE_OPT_IN), 'a hint entrega o opt-in FORTE, copiável');
      return true;
    },
  );

  assert.deepEqual(hashDir(dir), antes, 'nenhum arquivo do snapshot foi tocado');
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'articles.json'), 'utf8')).length, 2866);
  assert.deepEqual(git(dir, ['status', '--porcelain']), '', 'árvore limpa: nada p/ um `git add` levar');
});

test(`${SHRINK_OPT_IN} sozinho NÃO libera zerar o acervo`, () => {
  const dir = repoComAcervo(2866);
  const antes = hashDir(dir);
  assert.throws(
    () => exportWebSnapshot({ outDir: dir, allowShrink: true }),
    (e) => e instanceof SnapshotShrinkError && e.verdict.reason === 'wipe',
  );
  assert.deepEqual(hashDir(dir), antes);
});

test(`${WIPE_OPT_IN} libera a perda catastrófica (o único caminho que apaga de propósito)`, () => {
  const dir = repoComAcervo(2866);
  const r = exportWebSnapshot({ outDir: dir, allowShrink: 'wipe', live: 2866 });
  assert.equal(r.articles, 0);
  assert.equal(r.guard.reason, 'override-wipe');
  assert.equal(r.guard.override, true, 'override => o chamador loga ALTO (warn no assertSnapshotAllowed)');
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'articles.json'), 'utf8')), []);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')).totals.articles, 0);
});

test(`ponta a ponta pela CLI: argv "${WIPE_OPT_IN}" → parseFlags → cmdExport → export LIBERADO`, () => {
  // O caminho REAL do usuário bloqueado: ele copia o opt-in da mensagem e roda de novo. Antes, o
  // `cmdExport` não repassava a flag e a 2ª tentativa levava o MESMO bloqueio — para sempre.
  const dir = repoComAcervo(2866);
  const { flags, rest } = parseFlags(['export', '--format', 'web', '--out', dir, ...WIPE_OPT_IN.split(/\s+/)]);
  assert.deepEqual(rest, ['export']);
  assert.equal(flags['allow-shrink'], 'wipe');
  assert.ok(flags.out, 'nunca exportar p/ o webapp/public/data do repo REAL num teste');

  cmdExport(flags);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')).totals.articles, 0);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'articles.json'), 'utf8')), []);

  // e sem o opt-in a MESMA chamada pela CLI continua bloqueando (o guard não foi afrouxado).
  const outro = repoComAcervo(2866);
  const semOptIn = parseFlags(['export', '--format', 'web', '--out', outro]).flags;
  assert.throws(() => cmdExport(semOptIn), SnapshotShrinkError);
  assert.equal(JSON.parse(readFileSync(path.join(outro, 'meta.json'), 'utf8')).totals.articles, 2866);
});

test('base vazia e NADA publicado ainda (1º export) segue passando — única concessão fail-open', async () => {
  const { setLogSink } = await import('../src/util.js');
  const logs = [];
  setLogSink((e) => logs.push(e));
  try {
    const dir = path.join(NC_HOME_TMP, 'primeiro');
    const r = exportWebSnapshot({ outDir: dir });
    assert.equal(r.guard.reason, 'no-baseline');
    assert.equal(r.articles, 0);
    // ...mas NUNCA calado: publicar 0 artigo sem baseline é indistinguível do 1º export legítimo,
    // e é o que sai quando o git não pôde ser lido E o outDir sumiu E não veio `live`.
    const avisos = logs.filter((l) => l.level === 'warn' && /snapshot VAZIO/.test(l.text));
    assert.equal(avisos.length, 1, 'snapshot vazio sem baseline tem de AVISAR ALTO');
  } finally {
    setLogSink(null);
  }
});
