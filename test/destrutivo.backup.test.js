// TODA operação destrutiva passa a ser REVERSÍVEL: reset/purge/remove/finish --force tiram uma
// cópia CONSISTENTE do banco ANTES de apagar, e o backup que FALHA ABORTA a destruição (o
// oposto do que aconteceu em produção: o acervo do usuário foi apagado DUAS vezes por um reset
// da TUI, o de 2026-09-01 levando 3249 artigos e US$ 11,99 em 37.278 chamadas).
// Este arquivo prova, sobre o incidente REAL reproduzido (3249 artigos):
//   - o backup existe ANTES do wipe, abre e tem os 3249 artigos, e o caminho é dito ao usuário;
//   - com o diretório de backup somente-leitura, o `reset` ABORTA e o banco fica INTACTO;
//   - a confirmação forte (`--confirm <nº de artigos>`) — `--yes` sozinho não apaga mais nada;
//   - o purge é TRANSACIONAL (falha no meio não deixa a fonte pela metade);
//   - `remove` também faz backup, e o backup falho aborta a remoção;
//   - `finish --force` (que APAGA tags/resumos/vereditos) exige `--yes`.
// NC_HOME temporário ANTES do import (config.js -> db.js): o banco real nunca é aberto.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const NC_HOME_TMP = mkdtempSync(path.join(os.tmpdir(), 'nc-destrutivo-'));
process.env.NC_HOME = NC_HOME_TMP;
// NC_HOME/.env vazio VENCE o .env do repo real (shell < repo < NC_HOME): HAS_LLM=false, então
// `finish` é determinístico (nenhuma chamada de rede em teste nenhum daqui).
writeFileSync(path.join(NC_HOME_TMP, '.env'), 'OPENROUTER_API_KEY=\nDEEPSEEK_API_KEY=\nLLM_PROVIDER=\n');

const {
  cmdReset, cmdPurge, cmdRemove, cmdFinish, removeSourceById,
  backupBeforeDestructive, checkResetConfirmation, getResetImpact, resetImpactLines,
} = await import('../src/commands.js');
const { stmts, db, purgeSource, wipeAll } = await import('../src/db.js');
const { listBackups, countArticles: countArticlesIn } = await import('../src/backup.js');
const { BACKUP_DIR } = await import('../src/config.js');
const { setLogSink } = await import('../src/util.js');

const logs = [];
setLogSink((e) => logs.push(e));

const tmps = [NC_HOME_TMP];
after(() => {
  db.close();
  try {
    chmodSync(BACKUP_DIR, 0o700); // um teste deixa o diretório somente-leitura
  } catch {
    /* pode nem existir */
  }
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

function tmpdir(prefix) {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(d);
  return d;
}

// ---- helpers ----

const insertOne = (srcId, i) =>
  stmts.insertArticle.run({
    source_id: srcId,
    url: `https://incidente.test/artigo-${i}`,
    title: `Artigo ${i}`,
    content: `conteúdo do artigo ${i} — o que foi perdido no incidente de 2026-09-01`,
    content_hash: `hash-incidente-${i}`,
    published_at: '2026-08-31',
    run_id: null,
    kind: 'news',
    issue_url: null,
    section: null,
    blurb: null,
    content_source: 'target',
    cleaned: 0,
    needs_enrich: 0,
  });

/** Semeia N artigos numa fonte (transação: 3249 INSERTs com fsync por item seriam lentos). */
function seedArticles(n, { name = 'IncidenteFeed', url = 'https://incidente.test' } = {}) {
  const src = stmts.upsertSource.get({ name, base_url: url, type: 'listing', max_index_pages: null });
  db.transaction(() => {
    for (let i = 0; i < n; i++) insertOne(src.id, i);
  })();
  return src;
}

/** Roda `fn` com process.exit interceptado; devolve { exitCode } (null = não chamou). */
function withExitTrap(fn) {
  const original = process.exit;
  let exitCode = null;
  process.exit = (code) => {
    exitCode = code;
    throw new Error(`EXIT:${code}`);
  };
  try {
    fn();
  } catch (e) {
    if (!/^EXIT:/.test(String(e.message))) throw e;
  } finally {
    process.exit = original;
  }
  return { exitCode };
}

async function withExitTrapAsync(fn) {
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

// Zera o banco SEM passar pelo cmdReset (é setup de teste, não o comando sob teste).
const wipeEverything = () => wipeAll();

// ---- P1: o incidente reproduzido ----

test('reset do incidente (3249 artigos): backup ANTES do wipe, com os 3249 dentro, e o caminho dito ao usuário', () => {
  seedArticles(3249);
  assert.equal(stmts.countArticles.get().c, 3249, 'base do incidente semeada');

  logs.length = 0;
  const root = tmpdir('nc-reset-root-'); // fora de repo git: o marcador é escrito, não commitado
  const out = cmdReset({ yes: true, confirm: '3249' }, { root });

  assert.equal(stmts.countArticles.get().c, 0, 'o reset apagou tudo (o comando faz o que promete)');
  assert.ok(out.backup, 'o reset devolve a cópia que tirou');
  assert.ok(existsSync(out.backup.path), 'o arquivo de backup existe no disco');
  assert.equal(
    countArticlesIn(out.backup.path),
    3249,
    'o backup ABRE e tem os 3249 artigos (VACUUM INTO: cópia consistente, não o .db vazio do WAL)',
  );
  assert.equal(out.backup.reason, 'reset');
  const disse = logs.filter((l) => l.text.includes(out.backup.path));
  assert.ok(disse.length >= 1, 'o caminho do backup foi dito ao usuário nos logs');
  assert.ok(
    logs.some((l) => l.text.includes('BACKUP FEITO ANTES DE APAGAR') && l.text.includes('3249 artigo')),
    'a mensagem diz ONDE ficou e QUANTOS artigos tem',
  );
  assert.ok(
    logs.some((l) => l.text.includes(`cp "${out.backup.path}"`)),
    'a mensagem ensina como voltar (cp por cima do banco)',
  );
});

// ---- P2: backup falhando ABORTA ----

test('backup FALHANDO (diretório somente-leitura): o reset ABORTA e o banco continua intacto', (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignora permissão de diretório');
  seedArticles(120, { name: 'AbortaFeed', url: 'https://aborta.test' });
  const antes = stmts.countArticles.get().c;
  assert.equal(antes, 120);

  chmodSync(BACKUP_DIR, 0o500); // r-x: dá p/ listar, não dá p/ escrever
  try {
    // O guard sozinho já reprova (é o que o cmdReset consulta).
    const guard = backupBeforeDestructive('reset-teste');
    assert.equal(guard.ok, false, 'guard reprova quando o backup falha e o banco TEM dados');
    assert.equal(guard.reason, 'failed');

    logs.length = 0;
    const root = tmpdir('nc-reset-ro-');
    const { exitCode } = withExitTrap(() => cmdReset({ yes: true, confirm: String(antes) }, { root }));
    assert.equal(exitCode, 1, 'reset abortou com exit 1');
    assert.equal(stmts.countArticles.get().c, antes, 'banco INTACTO: nada foi apagado');
    assert.ok(
      logs.some((l) => l.level === 'error' && l.text.includes('reset ABORTADO')),
      'o usuário é avisado de que abortou',
    );
    assert.ok(
      !existsSync(path.join(root, '.nc-wipe.json')),
      'sem destruição, sem marcador de wipe (a fronteira só existe quando o dado morre)',
    );
  } finally {
    chmodSync(BACKUP_DIR, 0o700);
  }
});

test('backup falhando ABORTA também o purge e o remove (nada é apagado)', (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignora permissão de diretório');
  const src = stmts.upsertSource.get({
    name: 'FalhaFeed', base_url: 'https://falha.test', type: 'listing', max_index_pages: null,
  });
  insertOne(src.id, 90001);
  const antes = stmts.countArticles.get().c;

  chmodSync(BACKUP_DIR, 0o500);
  try {
    const { exitCode } = withExitTrap(() => cmdPurge(['FalhaFeed'], { yes: true }));
    assert.equal(exitCode, 1, 'purge abortou');
    assert.equal(stmts.countArticles.get().c, antes, 'nada apagado pelo purge');

    const res = removeSourceById(src.id);
    assert.match(String(res.error), /backup falhou/i, 'removeSourceById devolve erro em vez de apagar');
    assert.ok(stmts.getSourceById.get(src.id), 'a fonte continua cadastrada');
    assert.equal(stmts.countArticles.get().c, antes, 'nada apagado pelo remove');
  } finally {
    chmodSync(BACKUP_DIR, 0o700);
  }
  wipeEverything();
});

test('BACKUP_BEFORE_DESTRUCTIVE=false: segue sem rede, mas AVISA em voz alta', () => {
  seedArticles(3, { name: 'SemRedeFeed', url: 'https://semrede.test' });
  logs.length = 0;
  const guard = backupBeforeDestructive('reset', { required: false });
  assert.deepEqual(
    { ok: guard.ok, reason: guard.reason, backup: guard.backup },
    { ok: true, reason: 'disabled', backup: null },
  );
  assert.ok(logs.some((l) => l.level === 'warn' && /SEM rede de proteção/.test(l.text)), 'aviso explícito');
  wipeEverything();
});

test('banco VAZIO: o null do createBackup é legítimo ("não havia o que copiar") e a operação segue', () => {
  wipeEverything();
  logs.length = 0;
  const guard = backupBeforeDestructive('reset');
  assert.equal(guard.ok, true, 'sem dado, nada a copiar: não é falha');
  assert.equal(guard.reason, 'empty');
  assert.equal(guard.backup, null);
  assert.ok(logs.some((l) => /não havia o que copiar/.test(l.text)), 'o motivo é dito');
});

// ---- confirmação forte ----

test('checkResetConfirmation: --yes sozinho não basta; é preciso DIGITAR o nº de artigos', () => {
  const impact = { articles: 3249 };
  assert.equal(checkResetConfirmation(undefined, impact).reason, 'missing');
  assert.equal(checkResetConfirmation(true, impact).reason, 'missing', '--confirm sem valor não conta');
  assert.equal(checkResetConfirmation('3248', impact).reason, 'mismatch');
  assert.equal(checkResetConfirmation('sim', impact).reason, 'mismatch');
  assert.equal(checkResetConfirmation('3249', impact).ok, true);
  assert.equal(checkResetConfirmation(3249, impact).ok, true, 'número também vale');
  assert.equal(checkResetConfirmation(' 3.249 ', impact).ok, true, 'separador de milhar é aceito');
  // Base vazia não tem o que perder: o desafio some (senão o reset de um banco novo trava).
  assert.equal(checkResetConfirmation(undefined, { articles: 0 }).ok, true);
  assert.equal(checkResetConfirmation(undefined, { articles: 0 }).reason, 'empty');
});

test('reset com --yes mas SEM --confirm: recusa, mostra o que se perde e NÃO apaga', () => {
  seedArticles(7, { name: 'ConfirmFeed', url: 'https://confirm.test' });
  logs.length = 0;
  const root = tmpdir('nc-reset-confirm-');
  const { exitCode } = withExitTrap(() => cmdReset({ yes: true }, { root }));
  assert.equal(exitCode, 1);
  assert.equal(stmts.countArticles.get().c, 7, 'nada apagado');
  const texto = logs.map((l) => l.text).join('\n');
  assert.match(texto, /7 artigo\(s\)/, 'mostra quantos artigos se perdem');
  assert.match(texto, /US\$ .* de LLM em .* chamada/, 'mostra o gasto de LLM acumulado');
  assert.match(texto, /backup automático \(antes de apagar\) em/, 'mostra onde vai ficar o backup');
  assert.match(texto, /--yes --confirm 7/, 'ensina a confirmação exata');

  // Número ERRADO também recusa.
  logs.length = 0;
  const errado = withExitTrap(() => cmdReset({ yes: true, confirm: '8' }, { root }));
  assert.equal(errado.exitCode, 1);
  assert.equal(stmts.countArticles.get().c, 7, 'nada apagado com o número errado');
  assert.ok(logs.some((l) => /confirmação NÃO confere/.test(l.text)), 'diz por que recusou');

  // Com o número certo, apaga (e o backup fica).
  const out = cmdReset({ yes: true, confirm: '7' }, { root });
  assert.equal(stmts.countArticles.get().c, 0);
  assert.equal(countArticlesIn(out.backup.path), 7, 'a cópia de antes tem os 7');
});

test('getResetImpact/resetImpactLines: a mesma conta que a TUI vai mostrar', () => {
  wipeEverything();
  seedArticles(5, { name: 'ImpactoFeed', url: 'https://impacto.test' });
  const impact = getResetImpact();
  assert.equal(impact.articles, 5);
  assert.equal(impact.sources, 1);
  assert.equal(impact.backupDir, BACKUP_DIR);
  assert.ok(impact.lastBackup, 'os testes anteriores deixaram cópias — a mais recente aparece no aviso');
  const lines = resetImpactLines(impact);
  assert.ok(lines[0].includes('APAGA TODOS OS DADOS'));
  assert.ok(lines.join('\n').includes('5 artigo(s)'));
  wipeEverything();
});

// ---- P5: purge transacional ----

test('purge é TRANSACIONAL: falha no meio faz rollback total (nada apagado pela metade)', () => {
  const src = stmts.upsertSource.get({
    name: 'TxFeed', base_url: 'https://tx.test', type: 'listing', max_index_pages: null,
  });
  for (let i = 0; i < 5; i++) insertOne(src.id, 70000 + i);
  stmts.upsertPage.run({
    source_id: src.id, url: 'https://tx.test/issues/1', html_hash: 'h1', status: 200, pagination_depth: 0,
  });
  stmts.enqueue.run('https://tx.test/issues/1', 'listing', null, src.id, 0, null);
  const antes = {
    articles: stmts.countArticlesBySource.get(src.id).c,
    pages: stmts.countPages.get().c,
    frontier: stmts.countFrontier.get().c,
  };
  assert.equal(antes.articles, 5);
  assert.ok(antes.pages >= 1 && antes.frontier >= 1, 'pages e frontier semeadas');

  // Falha no ÚLTIMO passo (events): antes eram 4 `.run()` soltos e articles/pages/frontier já
  // teriam ido embora quando este estourasse.
  const original = stmts.deleteEventsBySource;
  stmts.deleteEventsBySource = {
    run() {
      throw new Error('disco cheio no meio do purge');
    },
  };
  try {
    assert.throws(() => purgeSource(src.id), /disco cheio/);
  } finally {
    stmts.deleteEventsBySource = original;
  }
  assert.equal(stmts.countArticlesBySource.get(src.id).c, antes.articles, 'artigos VOLTARAM (rollback)');
  assert.equal(stmts.countPages.get().c, antes.pages, 'pages intactas');
  assert.equal(stmts.countFrontier.get().c, antes.frontier, 'frontier intacta');

  // Sem a falha, o purge apaga tudo de uma vez e a fonte CONTINUA cadastrada.
  const counts = purgeSource(src.id);
  assert.equal(counts.articles, 5);
  assert.equal(stmts.countArticlesBySource.get(src.id).c, 0);
  assert.ok(stmts.getSourceById.get(src.id), 'purge não descadastra a fonte (isso é o remove)');
  wipeEverything();
});

test('purge/remove pelo comando: backup criado antes, com o acervo de ANTES dentro', () => {
  const src = seedArticles(4, { name: 'CmdFeed', url: 'https://cmd.test' });
  const antesDaLista = listBackups().length;
  cmdPurge(['CmdFeed'], { yes: true });
  const depois = listBackups();
  assert.equal(depois.length, antesDaLista + 1, 'uma cópia nova');
  assert.equal(countArticlesIn(depois[0].path), 4, 'a cópia tem o acervo de ANTES do purge');
  assert.match(depois[0].reason, /^purge-/, 'o motivo vai no nome do arquivo');
  assert.equal(stmts.countArticlesBySource.get(src.id).c, 0, 'purge fez o serviço');

  // remove: 2 artigos novos, backup próprio, e a fonte sai de vez.
  for (let i = 0; i < 2; i++) insertOne(src.id, 80000 + i);
  const res = removeSourceById(src.id);
  assert.ok(!res.error, 'remoção concluída');
  assert.equal(countArticlesIn(res.backup.path), 2, 'a cópia tem os 2 de antes do remove');
  assert.match(res.backup.reason, /^remove-/);
  assert.equal(stmts.getSourceById.get(src.id), undefined, 'fonte descadastrada');
  wipeEverything();
});

test('cmdRemove sem --yes recusa antes de qualquer backup', () => {
  const src = seedArticles(2, { name: 'RemoveFeed', url: 'https://remove.test' });
  const antes = listBackups().length;
  const { exitCode } = withExitTrap(() => cmdRemove(['RemoveFeed'], {}));
  assert.equal(exitCode, 1);
  assert.equal(listBackups().length, antes, 'sem --yes nem backup se tira');
  assert.ok(stmts.getSourceById.get(src.id), 'fonte intacta');
  wipeEverything();
});

// ---- finish --force ----

test('finish --force exige --yes (ele APAGA tags/resumos/vereditos do acervo inteiro)', async () => {
  seedArticles(3, { name: 'FinishFeed', url: 'https://finish.test' });
  logs.length = 0;
  const { exitCode } = await withExitTrapAsync(() => cmdFinish({ force: true }));
  assert.equal(exitCode, 1, 'recusado sem --yes');
  const texto = logs.map((l) => l.text).join('\n');
  assert.match(texto, /APAGA as tags\/classificações, os resumos e os vereditos/, 'diz o que se perde');
  assert.match(texto, /finish --force --yes/, 'ensina a confirmação');
  // A recusa vem ANTES do cheque de chave LLM: um flag destrutivo não depende de ter chave.
  assert.ok(
    !/ausente — finalizar os pendentes/.test(texto),
    'a mensagem de chave ausente não aparece antes da recusa do --force',
  );

  // Com --yes (e sem chave), o comando para no cheque de LLM — mas o backup do --force já saiu.
  logs.length = 0;
  const comYes = await withExitTrapAsync(() => cmdFinish({ force: true, yes: true }));
  assert.equal(comYes.exitCode, 1, 'sem chave LLM, o finish para no cheque de chave');
  assert.ok(
    logs.some((l) => /ausente — finalizar os pendentes/.test(l.text)),
    'e o motivo agora é a chave, não a confirmação',
  );
  wipeEverything();
});

test('finish SEM --force não pede nada (só completa os pendentes — não é destrutivo)', async () => {
  logs.length = 0;
  const { exitCode } = await withExitTrapAsync(() => cmdFinish({}));
  assert.equal(exitCode, 1, 'para no cheque de chave (ambiente sem LLM)');
  assert.ok(
    !logs.some((l) => /RE-PROCESSA o acervo INTEIRO/.test(l.text)),
    'nenhuma cerimônia de destruição no caminho normal',
  );
});
