// A JANELA do baseline high-water (src/export-web.js). O `-n` do rev-list conta commits QUE TOCAM
// o meta.json, então a janela é medida em DEPLOYS DE DADO: com 40 (o valor anterior) ela equivalia
// a ~2 meses no ritmo real deste repo — um wipe não detectado seguido de 40 commits no tamanho
// reduzido fazia o high-water ESQUECER o acervo original, ou seja, o ratchet voltava, só que mais
// devagar. Aqui o teste fixa as três garantias: a janela é CONFIGURÁVEL (EXPORT_HIGH_WATER_COMMITS),
// ela AVISA quando corta o histórico, e uma leitura de git que falha NÃO fica em silêncio (git fora
// do PATH + outDir apagado + sem `live` = baseline desconhecido, e um export de 0 artigos passaria
// como "primeiro snapshot").
// A env é lida no LOAD do módulo: por isso ela é definida ANTES do import dinâmico, e o valor
// minúsculo (2) prova o fio env → janela sem precisar de 1000 commits. Sem LLM/rede.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-export-highwater-test-'));
process.env.NC_HOME = NC_HOME_TMP;
process.env.EXPORT_HIGH_WATER_COMMITS = '2';

const { db } = await import('../src/db.js');
const { publishedHighWater } = await import('../src/export-web.js');
const { setLogSink } = await import('../src/util.js');

const logs = [];
setLogSink((e) => logs.push(e));
const warnsCom = (re) => logs.filter((l) => l.level === 'warn' && re.test(l.text));

const git = (dir, args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** Repo com um commit de meta.json por total em `totais` (ordem cronológica). */
function repoComHistorico(totais) {
  const dir = mkdtempSync(path.join(NC_HOME_TMP, 'repo-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'guard@test.local']);
  git(dir, ['config', 'user.name', 'Guard Test']);
  totais.forEach((n, i) => {
    // generatedAt distinto por commit: dois deploys com o MESMO total ainda são dois commits (sem
    // isso o `git commit` recusaria a árvore idêntica e o histórico do teste seria mais curto).
    const meta = { schemaVersion: 1, generatedAt: `2026-08-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`, totals: { articles: n } };
    writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 1)}\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', `acervo ${n}`]);
  });
  return dir;
}

after(() => {
  db.close();
  setLogSink(null);
  rmSync(NC_HOME_TMP, { recursive: true, force: true });
});

test('a janela é configurável e AVISA quando corta o histórico do meta.json', () => {
  // 2866 publicado, depois um wipe que virou 3, depois mais um deploy de 3: os 2 commits mais
  // recentes (a janela desta suíte) só conhecem 3 — é assim que o ratchet reaparece.
  const dir = repoComHistorico([2866, 3, 3]);

  logs.length = 0;
  assert.equal(publishedHighWater(dir), 3, 'janela de 2 commits esquece o acervo de 2866');
  assert.equal(warnsCom(/janela do high-water/).length, 1, 'janela que CORTA o histórico avisa alto');
  assert.match(warnsCom(/janela do high-water/)[0].text, /EXPORT_HIGH_WATER_COMMITS/);

  logs.length = 0;
  assert.equal(publishedHighWater(dir, { commits: 1000 }), 2866, 'a janela padrão (1000) lembra');
  assert.equal(warnsCom(/janela do high-water/).length, 0, 'sem corte, sem aviso');
});

test('a leitura em LOTES não muda o resultado (o maior total vem de qualquer lote)', () => {
  const dir = repoComHistorico([1, 2, 40, 5, 7]);
  assert.equal(publishedHighWater(dir, { commits: 1000 }), 40);
});

test('git fora do PATH: baseline DESCONHECIDO, mas nunca em silêncio', () => {
  const dir = repoComHistorico([2866]);
  const pathAntes = process.env.PATH;
  logs.length = 0;
  try {
    process.env.PATH = ''; // execFileSync('git') → ENOENT, o cenário "máquina sem git"
    assert.equal(publishedHighWater(dir), null, 'sem git não dá p/ provar nada: baseline null');
  } finally {
    process.env.PATH = pathAntes;
  }
  const avisos = warnsCom(/git não está no PATH/);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0].text, /CEGO/);
});

test('fora de um repo git segue em SILÊNCIO (é o caso normal de --out /tmp e dos testes)', () => {
  const dir = path.join(NC_HOME_TMP, 'sem-git');
  mkdirSync(dir, { recursive: true });
  logs.length = 0;
  assert.equal(publishedHighWater(dir), null);
  assert.deepEqual(warnsCom(/guard do snapshot/), [], 'nenhum ruído no caminho esperado');
});
