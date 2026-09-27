// PISO LEGADO (migração Jev, decisão 8: NÃO reprocessar o acervo existente). O acervo restaurado
// do git (15.502 artigos, todos com run_id NULL) e as runs anteriores à migração ficam FORA de toda
// varredura paga (verify / classify / summarize / reclean, inclusive o --force). Este arquivo prova:
//   - o boot semeia settings.jev_floor_run_id = MAX(runs.id)+1 (1 numa base nova) e NÃO o move depois;
//   - as 7 varreduras excluem run_id NULL (e run_id < piso) por padrão e só os incluem com includeLegacy;
//   - sem a linha de settings o SQL AINDA barra o NULL; a assinatura antiga `.all(lim)` lança;
//   - verifyPending/classifyPending/summarizePending/recleanSuspects repassam o includeLegacy;
//   - `finish|reclean --include-legacy` sem --yes imprime contagem + custo estimado e sai 1
//     (in-process e pela CLI de verdade), ANTES do cheque de chave;
//   - status separa "desta era (Jev)" de "legado (não processado)";
//   - `reextract` (re-clean + re-verify pagos) segue o MESMO piso: a seleção leve exclui o legado,
//     o "nada a re-extrair" ensina o --include-legacy e o portão conta exatamente o que roda;
//   - wipeAll (reset) re-semeia o piso (runs zerada => os ids recomeçam em 1).
// Nenhuma chamada LLM: NC_HOME/.env com chaves VAZIAS (HAS_LLM=false) e o único caminho que
// processa linhas (verifyPending) passa pela heurística determinística de menu de navegação.
// sandboxEnv() ANTES do import (config.js -> db.js): NC_HOME temporário E DB_PATH/BACKUP_DIR
// neutralizados — um DB_PATH ABSOLUTO no shell venceria o NC_HOME tmp e o wipeAll() do fim deste
// arquivo apagaria o banco REAL. Assim o banco real nunca é aberto (nem pelo filho da CLI, que
// herda este env e lê o mesmo NC_HOME/.env semeado).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { sandboxEnv } from './helpers/env.js';

// .env das OUTRAS casas deste arquivo (o boot em processo filho): mesmas chaves que a sandbox zera.
const EMPTY_ENV = 'OPENROUTER_API_KEY=\nDEEPSEEK_API_KEY=\nLLM_PROVIDER=\nDB_PATH=\nBACKUP_DIR=\n';
const SANDBOX = sandboxEnv({}, { homePrefix: 'nc-legacy-floor-' });
const NC_HOME_TMP = SANDBOX.home;
// Redundante com a sandbox (que já setou) — explícito p/ a malha do nc-home-isolation.test.js, que
// audita o assignment literal ANTES do 1º import de src/.
process.env.NC_HOME = NC_HOME_TMP;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  db, stmts, wipeAll, getLegacyFloor, isLegacyRow, countPendingByEra, LEGACY_FLOOR_KEY,
} = await import('../src/db.js');
const {
  cmdFinish, cmdReclean, cmdReextract, getStatus, printStatus, estimateLegacyUsd, shouldStreamPostSave, legacyLeftHint,
} = await import('../src/commands.js');
const { reextractTargets, selectReextractTargets } = await import('../src/reextract.js');
const { verifyPending, recleanSuspects } = await import('../src/verify.js');
const { summarizePending } = await import('../src/summarize.js');
const { classifyPending } = await import('../src/classify.js');
const { getFacets } = await import('../src/taxonomy.js');
const { estimateStageCallUsd } = await import('../src/budget.js');
const { stageModel } = await import('../src/config.js');
const { setLogSink } = await import('../src/util.js');

const logs = [];
setLogSink((e) => logs.push(e));
const logText = () => logs.map((l) => l.text).join('\n');

const tmps = [];
after(() => {
  setLogSink(null);
  db.close();
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
  SANDBOX.restore(); // devolve o env e apaga o NC_HOME tmp (depois do db.close)
});

/** Roda `fn` com process.exit interceptado; devolve { exitCode } (null = não chamou). */
async function withExitTrap(fn) {
  const original = process.exit;
  let exitCode = null;
  process.exit = (code) => {
    exitCode = code;
    throw new Error(`EXIT:${code}`);
  };
  try {
    await fn();
  } catch (e) {
    if (!/^EXIT:/.test(String(e.message))) throw e;
  } finally {
    process.exit = original;
  }
  return { exitCode };
}

// ---- boot ----

test('boot numa base NOVA: settings.jev_floor_run_id = 1 (MAX(runs.id)+1 sem runs)', () => {
  assert.equal(stmts.getSetting.get(LEGACY_FLOOR_KEY)?.value, '1');
  assert.equal(getLegacyFloor(), 1);
});

test('boot numa base COM runs: piso = MAX(runs.id)+1 e os boots seguintes NÃO o movem', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'nc-legacy-boot-'));
  tmps.push(home);
  writeFileSync(path.join(home, '.env'), EMPTY_ENV);
  const addRuns = (from, to) => {
    const pre = new Database(path.join(home, 'crawler.db'));
    // DDL real da tabela runs (a de db.js): o boot só a completa com ensureColumn.
    pre.exec(`CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY, command TEXT, args TEXT, budget_usd REAL, new_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running', started_at TEXT DEFAULT (datetime('now')), finished_at TEXT)`);
    const ins = pre.prepare('INSERT INTO runs (id, command) VALUES (?, ?)');
    for (let i = from; i <= to; i++) ins.run(i, 'crawl');
    pre.close();
  };
  // Boot REAL do db.js num processo filho (o ESM do processo de teste já carregou o seu db.js).
  const floorAtBoot = () => {
    const code =
      `const m = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'db.js')).href)});` +
      "process.stdout.write('FLOOR=' + m.getLegacyFloor()); m.db.close();";
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, NC_HOME: home, NC_UNDER_TEST: '1' },
    });
    const m = /FLOOR=(\d+)/.exec(r.stdout || '');
    assert.ok(m, `boot do filho falhou: ${r.stderr || r.stdout}`);
    return Number(m[1]);
  };
  addRuns(1, 7); // 7 runs da era ANTERIOR à migração
  assert.equal(floorAtBoot(), 8, 'piso = a próxima run');
  addRuns(8, 12); // runs desta era acontecem...
  assert.equal(floorAtBoot(), 8, 'INSERT OR IGNORE: o piso é fixado uma vez, as runs novas seguem >= piso');
});

// ---- cenário: legado (NULL + run anterior ao piso) × desta era ----
// Piso = 3: run 2 é "antes da migração"; runs 3 e 4 são desta era. O corpo abre com menu de
// navegação => verifyArticleRow decide 'suspect' pela heurística, SEM LLM.
const NAV = 'Home • Docs • Community • Blog • Changelog\n\nCorpo do artigo com texto suficiente.';
const ids = {};
function seed() {
  const src = stmts.upsertSource.get({ name: 'Piso', base_url: 'https://piso.test', type: 'listing', max_index_pages: null });
  const add = (key, runId, { verify = null, summary = false, classified = false } = {}) => {
    const r = stmts.insertArticle.run({
      source_id: src.id, url: `https://piso.test/${key}`, title: `T ${key}`, content: `${NAV} (${key})`,
      content_hash: `hash-${key}`, published_at: '2026-09-20', run_id: runId, kind: 'news', issue_url: null,
      section: null, blurb: null, content_source: 'target', cleaned: 0, needs_enrich: 0,
    });
    const id = Number(r.lastInsertRowid);
    ids[key] = id;
    if (verify) stmts.setVerify.run({ id, verify_status: verify, verify_notes: null });
    if (summary) stmts.setSummary.run({ id, title_pt: `T ${key}`, summary_pt: `resumo ${key}` });
    if (classified) {
      stmts.upsertClassification.run({
        article_id: id, result_json: '{"facets":{}}', domain_confidence: 0.9, taxonomy_version: 't',
        model_used: 'm', status: 'done',
      });
    }
  };
  add('L1', null); // restaurado, tudo pendente
  add('L2', null, { verify: 'suspect', summary: true, classified: true }); // restaurado, suspect
  add('P1', 2); // run anterior ao piso, tudo pendente
  add('J1', 3); // desta era, tudo pendente
  add('J2', 3, { verify: 'suspect', summary: true, classified: true });
  add('J3', 4, { verify: 'ok', summary: true, classified: true }); // desta era, completo
  stmts.setSetting.run({ key: LEGACY_FLOOR_KEY, value: '3' });
}

const idsOf = (rows) => rows.map((r) => r.id).sort((a, b) => a - b);
const pick = (...keys) => keys.map((k) => ids[k]).sort((a, b) => a - b);

test('isLegacyRow: NULL e < piso são legado; >= piso é desta era', () => {
  assert.equal(isLegacyRow({ run_id: null }, 3), true);
  assert.equal(isLegacyRow({}, 3), true);
  assert.equal(isLegacyRow({ run_id: 2 }, 3), true);
  assert.equal(isLegacyRow({ run_id: 3 }, 3), false);
  assert.equal(isLegacyRow({ run_id: 9 }, 3), false);
});

test('as 7 varreduras: padrão EXCLUI run_id NULL e < piso; includeLegacy os inclui', () => {
  seed();
  assert.equal(getLegacyFloor(), 3);
  const all6 = pick('L1', 'L2', 'P1', 'J1', 'J2', 'J3');
  const cases = {
    listArticlesToVerify: [pick('J1'), pick('L1', 'P1', 'J1')],
    listArticlesForReverifySweep: [pick('J1', 'J2', 'J3'), all6],
    listSuspectArticles: [pick('J2'), pick('L2', 'J2')],
    listArticlesNeedingSummary: [pick('J1'), pick('L1', 'P1', 'J1')],
    listArticlesForResummarize: [pick('J1', 'J2', 'J3'), all6],
    listArticlesNeedingClassification: [pick('J1'), pick('L1', 'P1', 'J1')],
    listArticlesForReclassify: [pick('J1', 'J2', 'J3'), all6],
  };
  for (const [name, [dflt, withLegacy]] of Object.entries(cases)) {
    assert.deepEqual(idsOf(stmts[name].all({ lim: -1 })), dflt, `${name}: padrão = só desta era`);
    assert.deepEqual(idsOf(stmts[name].all({ lim: -1, includeLegacy: false })), dflt, `${name}: includeLegacy=false`);
    assert.deepEqual(idsOf(stmts[name].all({ lim: -1, includeLegacy: true })), withLegacy, `${name}: includeLegacy`);
    const nulls = stmts[name].all({ lim: -1 }).filter((r) => r.id === ids.L1 || r.id === ids.L2);
    assert.equal(nulls.length, 0, `${name}: nenhum run_id NULL sem includeLegacy`);
  }
  // LIMIT continua valendo com a porta aberta
  assert.equal(stmts.listArticlesForResummarize.all({ lim: 2, includeLegacy: true }).length, 2);
});

test('@floor explícito (teste/override) move a fronteira, mas o NULL nunca entra', () => {
  assert.deepEqual(idsOf(stmts.listArticlesToVerify.all({ lim: -1, floor: 2 })), pick('P1', 'J1'));
  assert.deepEqual(idsOf(stmts.listArticlesToVerify.all({ lim: -1, floor: 1 })), pick('P1', 'J1'));
  assert.deepEqual(idsOf(stmts.listArticlesToVerify.all({ lim: -1, floor: 4 })), []);
});

test('assinatura antiga `.all(lim)` LANÇA (não roda sem piso por engano)', () => {
  assert.throws(() => stmts.listArticlesToVerify.all(-1), TypeError);
  assert.throws(() => stmts.listArticlesNeedingSummary.all(), TypeError);
});

test('sem a linha de settings: re-semeia pela regra do boot e o SQL AINDA barra run_id NULL', () => {
  stmts.deleteSetting.run(LEGACY_FLOOR_KEY);
  try {
    const rows = stmts.listArticlesToVerify.all({ lim: -1 }); // runs vazia => re-semeado em 1
    assert.ok(!rows.some((r) => r.id === ids.L1), 'NULL fora mesmo sem o piso gravado');
    assert.deepEqual(idsOf(rows), pick('P1', 'J1'));
    assert.equal(stmts.getSetting.get(LEGACY_FLOOR_KEY)?.value, '1', 're-semeado (MAX(runs.id)+1)');
    // valor ilegível: tratado como ausente (re-semeia), nunca como "sem piso"
    stmts.setSetting.run({ key: LEGACY_FLOOR_KEY, value: 'lixo' });
    assert.equal(getLegacyFloor(), 1);
  } finally {
    stmts.setSetting.run({ key: LEGACY_FLOOR_KEY, value: '3' });
  }
  assert.equal(getLegacyFloor(), 3);
});

test('countPendingByEra e getStatus: "desta era (Jev)" × "legado (não processado)"', () => {
  const era = countPendingByEra();
  assert.equal(era.floor, 3);
  assert.equal(era.total, 6);
  assert.equal(era.summaries, 3);
  assert.deepEqual(era.jev, { articles: 3, verify: 1, summary: 1, classify: 1, suspect: 1 });
  assert.deepEqual(era.legacy, { articles: 3, verify: 2, summary: 2, classify: 2, suspect: 1 });

  const s = getStatus();
  assert.equal(s.articles, 6);
  assert.equal(s.summaries, 3);
  assert.equal(s.pendingSummary, 1, 'o "rode finish" da UI só conta o que o finish processa');
  assert.equal(s.pendingClassif, 1);
  assert.equal(s.pendingVerify, 1);
  assert.deepEqual(s.legacy, { floor: 3, articles: 3, noVerify: 2, noSummary: 2, noClassif: 2, suspect: 1 });

  logs.length = 0;
  printStatus();
  const t = logText();
  assert.match(t, /resumos:.*desta era \(Jev\)=1 · legado \(não processado\)=2/);
  assert.match(t, /classif\.:.*desta era \(Jev\)=1 · legado \(não processado\)=2/);
  assert.match(t, /verific\.:.*desta era \(Jev\)=1 · legado \(não processado\)=2/);
  // A dica cita os PENDENTES do legado (o que o finish --include-legacy pega), não o total de
  // artigos legados — e SEM --yes: rodá-la mostra contagem × custo; o portão pede o --yes depois.
  assert.match(t, /legado: +2 sem veredito · 2 sem resumo · 2 sem tags \(de 3 artigo\(s\)/);
  assert.match(t, /ver contagem × custo: ncrawl finish --include-legacy$/m, 'status ensina como incluir o legado');
  assert.doesNotMatch(t, /--include-legacy --yes/, 'nenhuma dica pula a estimativa com um --yes pronto');
});

test('sweeps repassam includeLegacy ao stmt (default false; force usa o stmt de re-processo)', async () => {
  // Espião no stmt (o objeto stmts é compartilhado): devolve [] => o sweep retorna antes de
  // qualquer LLM. Prova a FIAÇÃO; a semântica do SQL já foi provada acima.
  const spy = async (name, fn) => {
    const orig = stmts[name];
    const seen = [];
    stmts[name] = { all: (p) => (seen.push(p), []) };
    try {
      await fn();
    } finally {
      stmts[name] = orig;
    }
    return seen.map((p) => p.includeLegacy);
  };
  assert.deepEqual(await spy('listArticlesNeedingSummary', () => summarizePending()), [false]);
  assert.deepEqual(await spy('listArticlesNeedingSummary', () => summarizePending({ includeLegacy: true })), [true]);
  assert.deepEqual(await spy('listArticlesForResummarize', () => summarizePending({ force: true })), [false]);
  assert.deepEqual(await spy('listArticlesNeedingClassification', () => classifyPending()), [false]);
  assert.deepEqual(await spy('listArticlesNeedingClassification', () => classifyPending({ includeLegacy: true })), [true]);
  assert.deepEqual(await spy('listArticlesForReclassify', () => classifyPending({ force: true, includeLegacy: true })), [true]);
  assert.deepEqual(await spy('listArticlesToVerify', () => verifyPending()), [false]);
  assert.deepEqual(await spy('listArticlesForReverifySweep', () => verifyPending({ force: true })), [false]);
  assert.deepEqual(await spy('listSuspectArticles', () => recleanSuspects()), [false]);
  assert.deepEqual(await spy('listSuspectArticles', () => recleanSuspects({ includeLegacy: true })), [true]);
});

test('estimateLegacyUsd: por artigo e por etapa (classify = 1 chamada por faceta)', () => {
  assert.equal(estimateLegacyUsd({}).total, 0);
  const one = estimateLegacyUsd({ verify: 1 });
  assert.ok(one.verify > 0 && one.total === one.verify);
  assert.ok(Math.abs(estimateLegacyUsd({ verify: 3 }).verify - 3 * one.verify) < 1e-12);
  const perCall = estimateStageCallUsd('classify', stageModel('classify').model);
  assert.ok(Math.abs(estimateLegacyUsd({ classify: 2 }).classify - 2 * getFacets().length * perCall) < 1e-12);
  const rc = estimateLegacyUsd({ reclean: 1 });
  assert.ok(rc.reclean > one.verify, 'reclean = limpeza forte + o re-verify');
});

// ---- --include-legacy: contagem + custo ANTES, e --yes obrigatório ----

test('finish --include-legacy SEM --yes: imprime contagem + custo estimado e sai 1 (antes do cheque de chave)', async () => {
  logs.length = 0;
  const { exitCode } = await withExitTrap(() => cmdFinish({ 'include-legacy': true }));
  assert.equal(exitCode, 1, 'recusado sem --yes');
  const t = logText();
  assert.match(t, /ACERVO LEGADO \(3 artigo\(s\) com run_id NULL ou < 3/);
  assert.match(t, /legado a processar: verificação=2 · resumos=2 · classificação=2/);
  assert.match(t, /custo estimado: ~US\$ \d/);
  assert.match(t, /Confirme com: {2}ncrawl finish --include-legacy --yes/);
  assert.ok(!/ausente — finalizar os pendentes/.test(t), 'a recusa vem ANTES do cheque de chave LLM');
});

test('finish --include-legacy respeita --limit e os --no-* na contagem', async () => {
  logs.length = 0;
  const { exitCode } = await withExitTrap(() => cmdFinish({ 'include-legacy': true, limit: '1', 'no-classify': true }));
  assert.equal(exitCode, 1);
  const t = logText();
  assert.match(t, /legado a processar: verificação=1 · resumos=1 · classificação=0/);
  assert.match(t, /ncrawl finish --include-legacy --yes --limit 1/);
});

test('finish --include-legacy --yes passa do portão (e aqui para no cheque de chave: sem LLM no teste)', async () => {
  logs.length = 0;
  const { exitCode } = await withExitTrap(() => cmdFinish({ 'include-legacy': true, yes: true }));
  assert.equal(exitCode, 1);
  const t = logText();
  assert.match(t, /legado a processar/, 'o impacto é mostrado mesmo confirmado');
  assert.ok(!/Confirme com/.test(t), 'confirmado: nada de pedir --yes de novo');
  assert.match(t, /ausente — finalizar os pendentes/, 'o motivo da parada agora é a chave');
});

test('finish --force --include-legacy --yes conta o legado INTEIRO (não só os pendentes)', async () => {
  logs.length = 0;
  await withExitTrap(() => cmdFinish({ 'include-legacy': true, force: true, yes: true }));
  assert.match(logText(), /legado a processar: verificação=3 · resumos=3 · classificação=3/);
});

test('finish --force --include-legacy SEM --yes: contagem × custo ANTES do pedido de --yes (e a linha repete --budget/--no-*)', async () => {
  logs.length = 0;
  const { exitCode } = await withExitTrap(() =>
    cmdFinish({ 'include-legacy': true, force: true, budget: '0.05', 'no-summarize': true }));
  assert.equal(exitCode, 1, 'recusado sem --yes');
  const t = logText();
  assert.match(t, /finish --force RE-PROCESSA por LLM todos os artigos do acervo \(legado incluído\)/);
  assert.match(t, /legado a processar: verificação=3 · resumos=0 · classificação=3/, 'o caminho MAIS caro mostra o impacto');
  assert.match(t, /custo estimado: ~US\$ \d/);
  assert.match(t, /Confirme com: {2}ncrawl finish --force --include-legacy --yes --budget 0\.05 --no-summarize /);
  assert.equal((t.match(/Confirme com:/g) || []).length, 1, 'UMA linha de confirmação (os dois portões juntos)');
  assert.ok(t.indexOf('legado a processar') < t.indexOf('Confirme com:'), 'a estimativa vem antes do pedido');
  assert.ok(!/ausente — finalizar os pendentes/.test(t), 'recusa antes do cheque de chave');
});

test('finish --force (sem --include-legacy) SEM --yes: recusa com a linha COMPLETA (--limit e --budget)', async () => {
  logs.length = 0;
  const { exitCode } = await withExitTrap(() => cmdFinish({ force: true, limit: '5', budget: '0.1' }));
  assert.equal(exitCode, 1);
  const t = logText();
  assert.match(t, /Confirme com: {2}ncrawl finish --force --yes --limit 5 --budget 0\.1 /);
  assert.doesNotMatch(t, /legado a processar/);
});

test('--limit negativo/lixo: finish, reclean e reextract recusam ANTES do portão (LIMIT -1 = sem limite no SQLite)', async () => {
  for (const [name, fn] of [['finish', cmdFinish], ['reclean', cmdReclean], ['reextract', cmdReextract]]) {
    for (const bad of ['-1', 'abc', '1.5', '', true]) {
      logs.length = 0;
      const { exitCode } = await withExitTrap(() => fn({ 'include-legacy': true, yes: true, limit: bad }));
      assert.equal(exitCode, 1, `${name} --limit ${JSON.stringify(bad)}`);
      const t = logText();
      assert.match(t, new RegExp(`${name}: --limit precisa ser um inteiro >= 0`));
      assert.doesNotMatch(t, /legado a processar/, 'nada de "0 itens / US$ 0" seguido do backlog inteiro');
    }
  }
  logs.length = 0;
  await withExitTrap(() => cmdFinish({ 'include-legacy': true, limit: '0' }));
  assert.match(logText(), /legado a processar: verificação=0 · resumos=0 · classificação=0/, '0 é válido (nada roda)');
});

test('finish SEM --include-legacy: a dica do legado cita os pendentes e NÃO traz --yes pronto', () => {
  const hint = legacyLeftHint(countPendingByEra());
  assert.match(hint, /2 sem veredito · 2 sem resumo · 2 sem tags/);
  assert.match(hint, /ncrawl finish --include-legacy\)\.$/);
  assert.doesNotMatch(hint, /--yes/, 'colar a dica mostra a estimativa; o --yes vem do portão');
  assert.equal(legacyLeftHint({ floor: 3, legacy: { verify: 0, summary: 0, classify: 0 } }), null, 'nada de fora: sem dica');
});

test('finish SEM --include-legacy não mostra o portão do legado', async () => {
  logs.length = 0;
  const { exitCode } = await withExitTrap(() => cmdFinish({}));
  assert.equal(exitCode, 1, 'para no cheque de chave (ambiente sem LLM)');
  assert.ok(!/legado a processar/.test(logText()));
});

test('reclean --include-legacy SEM --yes: conta os suspect do legado + custo e sai 1', async () => {
  logs.length = 0;
  const { exitCode } = await withExitTrap(() => cmdReclean({ 'include-legacy': true }));
  assert.equal(exitCode, 1);
  const t = logText();
  assert.match(t, /legado a processar: reclean \(suspect\)=1/);
  assert.match(t, /custo estimado: ~US\$ \d/);
  assert.match(t, /Confirme com: {2}ncrawl reclean --include-legacy --yes/);
  assert.ok(!/ausente — o reclean requer/.test(t));
});

test('CLI real: `finish --include-legacy` sem --yes sai 1 depois de imprimir contagem e custo', () => {
  // Mesmo NC_HOME tmp (herdado): o filho vê a base semeada acima. NODE_TEST_CONTEXT herdado +
  // --no-restore: nenhum bootstrap do git.
  const r = spawnSync(process.execPath, ['src/index.js', 'finish', '--include-legacy', '--no-restore'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, NC_HOME: NC_HOME_TMP },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.equal(r.status, 1, `esperava exit 1: ${out}`);
  assert.match(out, /legado a processar: verificação=2 · resumos=2 · classificação=2/);
  assert.match(out, /custo estimado: ~US\$ \d/);
  assert.match(out, /Confirme com: {2}ncrawl finish --include-legacy --yes/);
});

// ---- fim a fim sem LLM: verifyPending decide pela heurística (menu de navegação) ----

test('verifyPending: padrão só verifica o que é DESTA era; includeLegacy alcança o legado', async () => {
  const status = (k) => stmts.getArticleFullByUrl.get(`https://piso.test/${k}`).verify_status;
  const out = await verifyPending();
  assert.equal(out.verified, 1);
  assert.equal(status('J1'), 'suspect', 'desta era: verificado (heurística, sem LLM)');
  assert.equal(status('L1'), null, 'legado NULL: intocado');
  assert.equal(status('P1'), null, 'run anterior ao piso: intocado');

  const out2 = await verifyPending({ includeLegacy: true });
  assert.equal(out2.verified, 2);
  assert.equal(status('L1'), 'suspect');
  assert.equal(status('P1'), 'suspect');
});

// ---- reextract: mesmo piso (re-clean + re-verify do acervo antigo são pagos) ----

test('listReextractCandidates: leve (sem corpo) e com o piso — legado só com includeLegacy', () => {
  const dflt = stmts.listReextractCandidates.all({ lim: -1 });
  assert.deepEqual(idsOf(dflt), pick('J1', 'J2', 'J3'), 'padrão = só desta era');
  assert.ok(dflt.every((r) => !('content' in r)), 'lista leve: o corpo não é lido na seleção');
  assert.deepEqual(
    idsOf(stmts.listReextractCandidates.all({ lim: -1, includeLegacy: true })),
    pick('L1', 'L2', 'P1', 'J1', 'J2', 'J3'),
  );
  assert.throws(() => stmts.listReextractCandidates.all(-1), TypeError, 'assinatura antiga lança');
});

test('selectReextractTargets: --url e --limit por cima do piso', () => {
  assert.deepEqual(idsOf(selectReextractTargets({ urlFilter: 'piso.test/L' })), [], 'só legado casa: nada');
  assert.deepEqual(idsOf(selectReextractTargets({ urlFilter: 'PISO.TEST/L', includeLegacy: true })), pick('L1', 'L2'));
  assert.deepEqual(idsOf(selectReextractTargets({ limit: 2, includeLegacy: true })), pick('L1', 'L2'), 'ordem de id');
  assert.deepEqual(idsOf(selectReextractTargets({ limit: Infinity })), pick('J1', 'J2', 'J3'));
});

test('reextractTargets: padrão NÃO toca o legado (e ensina o --include-legacy); com ele, re-extrai', async () => {
  const P =
    'Parágrafo de prosa real com tamanho suficiente para o extrator aceitar o documento como artigo, ' +
    'porque abaixo do mínimo de texto o fluxo cairia noutro ramo antes da gravação que este teste quer ' +
    'observar de fato, e a prova ficaria silenciosamente vazia sem ninguém perceber a diferença. ';
  const page = `<!DOCTYPE html><html><head><title>Novo</title></head><body><article><h1>Novo</h1>${
    Array.from({ length: 8 }, (_, i) => `<p>${i}. ${P}</p>`).join('')}</article></body></html>`;
  const fetched = [];
  const fetchSmartImpl = async (u) => (fetched.push(u), { html: page, url: u });
  const before = stmts.getArticleFullByUrl.get('https://piso.test/L1').content;

  logs.length = 0;
  const out = await reextractTargets({ urlFilter: 'piso.test/L1', fetchSmartImpl });
  assert.equal(out.reextracted, 0);
  assert.equal(fetched.length, 0, 'nem o fetch roda p/ ficha legado');
  assert.equal(stmts.getArticleFullByUrl.get('https://piso.test/L1').content, before, 'corpo intocado');
  assert.match(logText(), /1 ficha\(s\) do acervo LEGADO casam; incluir: --include-legacy \(mostra contagem × custo antes do --yes\)/);

  const out2 = await reextractTargets({ urlFilter: 'piso.test/L1', includeLegacy: true, fetchSmartImpl });
  assert.equal(out2.reextracted, 1, 'com a porta aberta a ficha legado é re-extraída');
  assert.deepEqual(fetched, ['https://piso.test/L1']);
  assert.notEqual(stmts.getArticleFullByUrl.get('https://piso.test/L1').content, before);
  assert.equal(stmts.getArticleFullByUrl.get('https://piso.test/L1').run_id, null, 'reextract não re-carimba a era');
});

test('reextract --include-legacy SEM --yes: conta (com --url/--limit) + custo e sai 1', async () => {
  logs.length = 0;
  const { exitCode } = await withExitTrap(() => cmdReextract({ 'include-legacy': true, url: 'piso.test/' }));
  assert.equal(exitCode, 1, 'recusado sem --yes');
  let t = logText();
  assert.match(t, /reextract --include-legacy: o ACERVO LEGADO \(3 artigo\(s\)/);
  assert.match(t, /legado a processar: reextract \(alvo\)=3/, 'L1, L2, P1 (J* são desta era)');
  assert.match(t, /custo estimado: US\$ 0 \(sem chave LLM/, 'sem chave: só a parte determinística');
  assert.match(t, /Confirme com: {2}ncrawl reextract --include-legacy --yes --url piso\.test\//);

  logs.length = 0;
  await withExitTrap(() => cmdReextract({ 'include-legacy': true, limit: '2' }));
  t = logText();
  assert.match(t, /legado a processar: reextract \(alvo\)=2/, 'o --limit capa a contagem (L1, L2 = os 2 primeiros)');
  assert.match(t, /--include-legacy --yes --limit 2/);
});

test('estimateLegacyUsd: reextract = limpeza + re-verify por ficha', () => {
  const one = estimateLegacyUsd({ reextract: 1 });
  assert.ok(one.reextract > estimateLegacyUsd({ verify: 1 }).verify);
  assert.equal(one.total, one.reextract);
});

// ---- streaming pós-save (crawl): mesmo piso ----

test('streaming pós-save: ficha legado (restaurada e RE-ENRIQUECIDA pelo crawl) não entra; desta era entra', () => {
  assert.equal(shouldStreamPostSave(undefined, 3), false, 'sumiu: pula');
  assert.equal(shouldStreamPostSave({ run_id: null }, 3), false);
  assert.equal(shouldStreamPostSave({ run_id: 2 }, 3), false, 'run anterior ao piso');
  assert.equal(shouldStreamPostSave({ run_id: 3 }, 3), true);
  // O enrichArticle do crawl.js NÃO passa run_id (coalesce mantém o NULL): a ficha restaurada que o
  // crawl re-enriquece SEGUE legado — é exatamente o caso em que o guard do streaming dispara.
  const orig = stmts.getArticleFullByUrl.get('https://piso.test/L2');
  const enrich = (content, hash) => stmts.enrichArticle.run({
    id: orig.id, title: orig.title, content, content_hash: hash, published_at: orig.published_at,
    content_source: 'target', cleaned: 0,
  });
  try {
    enrich(`${orig.content} (enriquecido)`, 'hash-L2-enriched');
    const row = stmts.getArticleFullByUrl.get('https://piso.test/L2');
    assert.equal(row.run_id, null, 're-enriquecer não re-carimba a era');
    assert.equal(shouldStreamPostSave(row, getLegacyFloor()), false);
    assert.equal(shouldStreamPostSave(stmts.getArticleFullByUrl.get('https://piso.test/J1'), getLegacyFloor()), true);
  } finally {
    enrich(orig.content, orig.content_hash);
  }
});

// ---- reset ----

test('wipeAll re-semeia o piso: runs zerada => ids recomeçam em 1 => piso 1', () => {
  stmts.setSetting.run({ key: LEGACY_FLOOR_KEY, value: '42' });
  assert.equal(getLegacyFloor(), 42);
  wipeAll();
  assert.equal(stmts.getSetting.get(LEGACY_FLOOR_KEY)?.value, '1');
  assert.equal(getLegacyFloor(), 1);
});
