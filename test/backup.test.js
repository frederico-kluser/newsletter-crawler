// src/backup.js — o cinto de segurança que torna reset/purge/remove REVERSÍVEIS.
// Cobre: cópia consistente de um banco em WAL (com a contagem certa e restaurável), banco vazio,
// retenção que nunca apaga a mais recente nem a mais rica, falha de filesystem sem exceção e
// listagem tolerante a arquivo corrompido.
// NC_HOME tmp + .env vazio ANTES de importar config (padrão do commands.summary.test.js): NENHUM
// teste pode encostar no ~/.newsletter-crawler REAL do usuário.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readdirSync,
  existsSync,
  copyFileSync,
  utimesSync,
  lutimesSync,
  symlinkSync,
  statSync,
  chmodSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { load as loadVec } from 'sqlite-vec';
import { setLogSink } from '../src/util.js';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-backup-'));
writeFileSync(
  path.join(process.env.NC_HOME, '.env'),
  'OPENROUTER_API_KEY=\nDEEPSEEK_API_KEY=\nLLM_PROVIDER=\n',
);

const {
  createBackup,
  listBackups,
  pruneBackups,
  latestBackup,
  bestBackup,
  countArticles,
  isBackupName,
  isBackupDue,
  BACKUP_DIR,
} = await import('../src/backup.js');
const { DB_PATH, NC_HOME, BACKUP_KEEP, BACKUP_KEEP_DEFAULT, BACKUP_BEFORE_DESTRUCTIVE, BACKUP_MIN_INTERVAL_MS, EMBED_DIM } =
  await import('../src/config.js');

const TMP = process.env.NC_HOME;
const open = [];
/** Banco de origem com N artigos, em WAL e com a conexão ABERTA (dado ainda no -wal, sem checkpoint). */
function makeDb(file, n) {
  const d = new Database(file);
  d.pragma('journal_mode = WAL');
  d.exec('CREATE TABLE articles (id INTEGER PRIMARY KEY, url TEXT UNIQUE, title TEXT)');
  const ins = d.prepare('INSERT INTO articles (url, title) VALUES (?, ?)');
  d.transaction((k) => {
    for (let i = 0; i < k; i++) ins.run(`https://x/${i}`, `t${i}`);
  })(n);
  open.push(d);
  return d;
}
const dbFiles = (dir) => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.db'));
  } catch {
    return [];
  }
};
const sub = (name) => {
  const d = path.join(TMP, name);
  mkdirSync(d, { recursive: true });
  return d;
};
/** Banco com tabelas de DADOS mas ZERO artigos — o estado real do banco do usuário depois de um
 *  reset: sources/selectors (derivados por IA, custaram dinheiro) e llm_usage (o ledger do gasto). */
function makeDbNoArticles(file) {
  const d = new Database(file);
  d.pragma('journal_mode = WAL');
  d.exec(`CREATE TABLE articles (id INTEGER PRIMARY KEY, url TEXT UNIQUE, title TEXT);
          CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT, base_url TEXT);
          CREATE TABLE selectors (id INTEGER PRIMARY KEY, template_sig TEXT, link_selector TEXT);
          CREATE TABLE llm_usage (id INTEGER PRIMARY KEY, stage TEXT, cost REAL);
          CREATE TABLE runs (id INTEGER PRIMARY KEY, started_at TEXT);`);
  open.push(d);
  return d;
}
/** Carimbo do backup no formato do módulo (o teste precisa PREVER o nome que o createBackup vai
 *  escolher para simular o outro processo). Mesma regra de src/backup.js. */
const stampOf = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
/** Roda `fn` capturando TODO o log do módulo (util setLogSink) — é como se lê a MENSAGEM. */
function captureLogs(fn) {
  const lines = [];
  setLogSink((e) => lines.push(`${e.level}: ${e.text}`));
  try {
    return { value: fn(), lines };
  } finally {
    setLogSink(null);
  }
}

after(() => {
  for (const d of open) {
    try {
      d.close();
    } catch {
      /* já fechado */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

test('isolamento: DB_PATH e BACKUP_DIR ficam DENTRO do NC_HOME de teste (nunca no ~ real)', () => {
  assert.equal(NC_HOME, TMP);
  assert.ok(DB_PATH.startsWith(TMP), `DB_PATH fora do tmp: ${DB_PATH}`);
  assert.ok(BACKUP_DIR.startsWith(TMP), `BACKUP_DIR fora do tmp: ${BACKUP_DIR}`);
  assert.equal(BACKUP_DIR, path.join(TMP, 'backups'));
  assert.equal(BACKUP_KEEP, 10);
  assert.equal(BACKUP_KEEP_DEFAULT, 10);
  assert.equal(BACKUP_BEFORE_DESTRUCTIVE, true);
  assert.equal(BACKUP_MIN_INTERVAL_MS, 3600000);
  // O wiring acima só prova o caminho; isto prova o NEGATIVO: nenhum caminho deste teste pode
  // cair no ~/.newsletter-crawler REAL (o banco de verdade do usuário mora lá).
  const real = path.join(os.homedir(), '.newsletter-crawler');
  for (const p of [DB_PATH, BACKUP_DIR, NC_HOME]) {
    assert.ok(!path.resolve(p).startsWith(real + path.sep), `${p} aponta para o NC_HOME REAL`);
    assert.notEqual(path.resolve(p), real);
  }
});

test('F1/F2: banco em WAL vira cópia ÍNTEGRA, restaurável e com a contagem certa', () => {
  const src = path.join(sub('src-wal'), 'crawler.db');
  makeDb(src, 500); // conexão fica aberta: os 500 artigos estão no -wal, não no .db
  const dir = sub('bk-wal');

  const r = createBackup({ reason: 'reset', dbPath: src, dir });
  assert.ok(r, 'backup deveria ter sido criado');
  assert.equal(r.articles, 500, 'o backup declara os artigos que contém');
  assert.equal(r.reason, 'reset');
  assert.match(r.name, /^crawler-\d{8}T\d{6}Z-reset\.db$/, 'timestamp ISO compacto + motivo no nome');
  assert.ok(r.bytes > 0 && Number.isFinite(r.elapsedMs));
  assert.ok(existsSync(r.path));

  // Abre DEPOIS e consulta: mesma contagem + integrity_check ok (é isto que o restore vai usar).
  const c = new Database(r.path, { readonly: true, fileMustExist: true });
  assert.equal(c.prepare('SELECT count(*) AS c FROM articles').get().c, 500);
  assert.equal(c.pragma('integrity_check', { simple: true }), 'ok');
  c.close();
  assert.equal(countArticles(r.path), 500);

  // Prova de por que NÃO é copyFileSync: o .db sozinho nunca contém MAIS do que o backup, e pode
  // não conter nada (o dado vive no -wal até o checkpoint). A afirmação é sobre o MÓDULO ("o
  // backup tem tudo"), não sobre a hora em que o SQLite resolve fazer auto-checkpoint — asserção
  // do tipo `notEqual(countArticles(raw), 500)` dependeria do ambiente, não do código.
  const raw = path.join(sub('src-wal'), 'raw-copy.db');
  copyFileSync(src, raw);
  const rawCount = countArticles(raw);
  assert.ok(rawCount === null || rawCount <= 500, `cópia crua não pode ter mais que a origem: ${rawCount}`);
  assert.equal(r.articles, 500, 'o backup, esse, tem tudo');
});

test('banco SEM DADO NENHUM (todas as tabelas vazias) não vira backup — cópia do nada engana o restore', () => {
  const src = path.join(sub('src-empty'), 'crawler.db');
  makeDb(src, 0);
  const dir = sub('bk-empty');
  assert.equal(createBackup({ reason: 'reset', dbPath: src, dir }), null);
  assert.deepEqual(dbFiles(dir), [], 'nenhum arquivo criado');
  assert.deepEqual(listBackups(dir), []);
  assert.equal(latestBackup(dir), null);
  assert.equal(bestBackup(dir), null);
});

test('F3: retenção keep=1 NUNCA apaga a mais recente nem a com MAIS artigos', () => {
  const dir = sub('bk-prune');
  const s1 = path.join(sub('src-prune'), 'a.db');
  const s2 = path.join(sub('src-prune'), 'b.db');
  const s3 = path.join(sub('src-prune'), 'c.db');
  makeDb(s1, 300); // a MAIS RICA e a MAIS ANTIGA (o pior caso: os dois critérios divergem)
  makeDb(s2, 10);
  makeDb(s3, 20);
  const rich = createBackup({ reason: 'antiga', dbPath: s1, dir });
  const mid = createBackup({ reason: 'meio', dbPath: s2, dir });
  const newest = createBackup({ reason: 'nova', dbPath: s3, dir });

  // mtimes explícitos: a ordem do teste não pode depender da resolução do relógio.
  const t = Math.floor(Date.now() / 1000);
  utimesSync(rich.path, t - 300, t - 300);
  utimesSync(mid.path, t - 200, t - 200);
  utimesSync(newest.path, t - 100, t - 100);

  assert.equal(latestBackup(dir).path, newest.path);
  assert.equal(bestBackup(dir).path, rich.path);
  assert.equal(bestBackup(dir).articles, 300);

  const removed = pruneBackups({ keep: 1, dir });
  assert.deepEqual(removed, [mid.path], 'só a do meio pode cair');
  assert.ok(existsSync(newest.path), 'a mais recente sobrevive');
  assert.ok(existsSync(rich.path), 'a mais rica sobrevive mesmo fora da janela keep');
  assert.equal(dbFiles(dir).length, 2);

  // keep=0 (ou lixo) não zera a pasta: cai p/ 1 e as duas protegidas continuam de pé.
  assert.deepEqual(pruneBackups({ keep: 0, dir }), []);
  assert.deepEqual(pruneBackups({ keep: Number.NaN, dir }), []);
  assert.equal(dbFiles(dir).length, 2);
  // keep maior que o acervo não remove nada.
  assert.deepEqual(pruneBackups({ keep: 10, dir }), []);
});

test('F4: falha de filesystem/banco NÃO lança — devolve null (quem chama decide se aborta)', () => {
  const src = path.join(sub('src-fail'), 'crawler.db');
  makeDb(src, 5);

  // (a) destino IMPOSSÍVEL: o caminho do diretório já é um ARQUIVO -> mkdir falha.
  const blocked = path.join(sub('fail'), 'not-a-dir');
  writeFileSync(blocked, 'sou um arquivo');
  assert.doesNotThrow(() => createBackup({ reason: 'reset', dbPath: src, dir: blocked }));
  assert.equal(createBackup({ reason: 'reset', dbPath: src, dir: blocked }), null);

  // (b) diretório SOMENTE-LEITURA (o caso "NC_HOME sem permissão").
  const ro = sub('fail-ro');
  const roDir = path.join(ro, 'backups');
  mkdirSync(roDir, { recursive: true });
  const mode = statSync(roDir).mode;
  try {
    chmodSync(roDir, 0o500);
    assert.equal(createBackup({ reason: 'reset', dbPath: src, dir: roDir }), null);
    assert.deepEqual(dbFiles(roDir), []);
  } finally {
    chmodSync(roDir, mode);
  }

  // (c) origem ausente e (d) origem corrompida.
  assert.equal(createBackup({ reason: 'reset', dbPath: path.join(TMP, 'nao-existe.db'), dir: sub('bk-fail') }), null);
  const junk = path.join(sub('src-fail'), 'corrompido.db');
  writeFileSync(junk, 'isto não é um banco SQLite');
  assert.equal(countArticles(junk), null);
  assert.equal(createBackup({ reason: 'reset', dbPath: junk, dir: sub('bk-fail') }), null);

  // (e) listar/podar diretório inexistente é inofensivo.
  const ghost = path.join(TMP, 'nunca-criado');
  assert.deepEqual(listBackups(ghost), []);
  assert.deepEqual(pruneBackups({ keep: 3, dir: ghost }), []);
  assert.equal(latestBackup(ghost), null);
});

test('listBackups tolera arquivo corrompido: articles null, sem exceção, e nunca vira "a melhor"', () => {
  const dir = sub('bk-corrupt');
  const src = path.join(sub('src-corrupt'), 'crawler.db');
  makeDb(src, 7);
  const good = createBackup({ reason: 'crawl', dbPath: src, dir });
  const bad = path.join(dir, 'crawler-20260101T000000Z-corrompido.db');
  writeFileSync(bad, 'nem SQLite nem nada');

  const list = listBackups(dir);
  assert.equal(list.length, 2);
  const badEntry = list.find((b) => b.path === bad);
  assert.equal(badEntry.articles, null, 'ilegível vira null, nunca lança');
  assert.equal(badEntry.reason, 'corrompido');
  assert.equal(badEntry.stamp, '20260101T000000Z');
  assert.equal(list.find((b) => b.path === good.path).articles, 7);
  assert.equal(bestBackup(dir).path, good.path, 'a corrompida jamais é escolhida pelo restore');
  // A poda pode apagar a corrompida (fora da janela e não protegida) — mas nunca a boa.
  utimesSync(bad, 1, 1); // bem antiga
  assert.deepEqual(pruneBackups({ keep: 1, dir }), [bad]);
  assert.ok(existsSync(good.path));
});

test('backup periódico respeita o intervalo mínimo (isBackupDue + minIntervalMs)', () => {
  const dir = sub('bk-interval');
  const src = path.join(sub('src-interval'), 'crawler.db');
  makeDb(src, 3);
  assert.equal(isBackupDue({ minIntervalMs: 60000, dir }), true, 'sem backup nenhum, sempre devido');
  const first = createBackup({ reason: 'crawl', dbPath: src, dir, minIntervalMs: 60000 });
  assert.ok(first);
  assert.equal(isBackupDue({ minIntervalMs: 60000, dir }), false);
  assert.equal(createBackup({ reason: 'crawl', dbPath: src, dir, minIntervalMs: 60000 }), null, 'pulou: cópia recente');
  assert.equal(dbFiles(dir).length, 1);
  // Intervalo 0/desligado -> sempre copia (é o caminho das operações destrutivas).
  assert.equal(isBackupDue({ minIntervalMs: 0, dir }), true);
  assert.ok(createBackup({ reason: 'reset', dbPath: src, dir }));
  assert.equal(dbFiles(dir).length, 2);
});

test('default: sem `dir`, o backup cai em BACKUP_DIR (NC_HOME/backups), criado sob demanda', () => {
  const src = path.join(sub('src-default'), 'crawler.db');
  makeDb(src, 4);
  assert.equal(existsSync(BACKUP_DIR), false, 'o import NÃO cria o diretório');
  const r = createBackup({ reason: 'purge Hacker News!', dbPath: src });
  assert.ok(r);
  assert.equal(path.dirname(r.path), BACKUP_DIR);
  assert.match(r.name, /^crawler-\d{8}T\d{6}Z-purge-hacker-news\.db$/, 'motivo higienizado no nome');
  assert.equal(latestBackup().path, r.path);
  // Dois backups no MESMO segundo não colidem (VACUUM INTO recusa sobrescrever).
  const r2 = createBackup({ reason: 'purge Hacker News!', dbPath: src });
  assert.ok(r2 && r2.path !== r.path);
  assert.equal(listBackups().length, 2);
});

// ---- D1: a poda NUNCA pode apagar o banco VIVO (as três camadas, exercitadas separadamente) ----
// Contexto: `BACKUP_DIR` relativo resolve contra NC_HOME, então `BACKUP_DIR=.` fazia BACKUP_DIR
// virar o diretório do banco. `listBackups` aceitava QUALQUER *.db e, depois de um reset, o
// crawler.db vivo tinha 0 artigos -> `richest` o ignorava, ele caía no `slice(keep)` e ia p/ o
// unlinkSync. O revisor reproduziu: "### O BANCO VIVO crawler.db AINDA EXISTE? false".

test('D1(a): a poda só apaga arquivo que casa o NAME_RE — o crawler.db VIVO nunca entra na lista', () => {
  const dir = sub('d1a-backups');
  const liveDir = sub('d1a-live');
  const live = path.join(liveDir, 'crawler.db');
  makeDb(live, 0); // exatamente o pós-reset do repro: banco vivo com 0 artigos
  const rich = path.join(sub('d1a-src'), 'rico.db');
  makeDb(rich, 3249);
  const backups = [];
  for (let i = 0; i < 3; i++) backups.push(createBackup({ reason: `r${i}`, dbPath: rich, dir }));
  assert.equal(backups.filter(Boolean).length, 3);

  // O repro: o banco vivo (e outro .db qualquer) DENTRO da pasta de backups.
  const liveInDir = path.join(dir, 'crawler.db');
  copyFileSync(live, liveInDir);
  const foreign = path.join(dir, 'exportado.db');
  writeFileSync(foreign, 'outro .db qualquer, não é backup nosso');

  assert.equal(isBackupName('crawler.db'), false);
  assert.equal(isBackupName('exportado.db'), false);
  assert.equal(isBackupName(path.basename(backups[0].path)), true);
  assert.equal(
    listBackups(dir).some((b) => b.name === 'crawler.db' || b.name === 'exportado.db'),
    false,
    'listBackups só enxerga backups DESTE módulo',
  );

  const removed = pruneBackups({ keep: 1, dir, dbPath: live });
  assert.equal(existsSync(liveInDir), true, 'O BANCO VIVO crawler.db AINDA EXISTE');
  assert.equal(existsSync(foreign), true, 'nenhum .db alheio é apagado');
  assert.equal(
    removed.every((r) => isBackupName(path.basename(r))),
    true,
    'tudo que caiu é backup nosso',
  );
  assert.equal(removed.length, 2, 'sobram a mais recente (== a mais rica) e nada mais da janela');
});

test('D1(b): a poda RECUSA apagar o DB_PATH e seus sidecars, mesmo por symlink (caminho REAL)', () => {
  const dir = sub('d1b-backups');
  const liveDir = sub('d1b-live');
  const live = path.join(liveDir, 'crawler.db');
  makeDb(live, 3); // poucos artigos DE PROPÓSITO: a armadilha não pode ser salva por "a mais rica"
  const src = path.join(sub('d1b-src'), 'fonte.db');
  makeDb(src, 100);
  const b1 = createBackup({ reason: 'um', dbPath: src, dir });
  const b2 = createBackup({ reason: 'dois', dbPath: src, dir });
  assert.ok(b1 && b2);

  // Armadilha: um symlink com NOME de backup apontando para o banco vivo (passa a camada (a)).
  const trap = path.join(dir, 'crawler-20200101T000000Z-armadilha.db');
  symlinkSync(live, trap);
  lutimesSync(trap, 1, 1); // bem antigo: cai fora da janela keep (lutimes NÃO mexe no alvo)
  const trapWal = path.join(dir, 'crawler-20200101T000000Z-sidecar.db');
  symlinkSync(`${live}-wal`, trapWal);
  lutimesSync(trapWal, 1, 1);

  assert.equal(listBackups(dir).some((b) => b.path === trap), true, 'a armadilha ENTRA na lista (nome válido)');
  const removed = pruneBackups({ keep: 1, dir, dbPath: live });
  assert.equal(existsSync(live), true, 'O BANCO VIVO AINDA EXISTE');
  assert.equal(countArticles(live), 3, 'e continua com os artigos');
  assert.equal(removed.includes(trap), false, 'o symlink p/ o banco vivo NÃO foi apagado');
  assert.equal(removed.includes(trapWal), false, 'nem o symlink p/ o sidecar -wal');
  assert.equal(existsSync(trap), true);
});

test('D1(c): BACKUP_DIR no mesmo diretório do banco vivo DESLIGA a retenção (recusa alta e barulhenta)', () => {
  // `BACKUP_DIR=.` era exatamente isto. Recusar podar só custa disco; podar aqui já custou o
  // acervo do usuário. O backup em si continua sendo criado — a rede de proteção não cai.
  const liveDir = sub('d1c-live');
  const live = path.join(liveDir, 'crawler.db');
  makeDb(live, 3249);
  const feitos = [];
  for (let i = 0; i < 4; i++) feitos.push(createBackup({ reason: `r${i}`, dbPath: live, dir: liveDir }));
  assert.equal(feitos.filter(Boolean).length, 4, 'o backup CONTINUA funcionando na config perigosa');

  const { value: removed, lines } = captureLogs(() => pruneBackups({ keep: 1, dir: liveDir, dbPath: live }));
  assert.deepEqual(removed, [], 'nada foi apagado');
  assert.ok(
    lines.some((l) => /retenção RECUSADA/.test(l)),
    `aviso alto ausente: ${lines.join(' | ')}`,
  );
  assert.equal(existsSync(live), true, 'O BANCO VIVO crawler.db AINDA EXISTE');
  assert.equal(listBackups(liveDir).length, 4, 'e as 4 cópias continuam lá');

  // Mesmo diretório por SYMLINK também é recusado (comparação por caminho real).
  const alias = path.join(TMP, 'd1c-alias');
  symlinkSync(liveDir, alias);
  assert.deepEqual(pruneBackups({ keep: 1, dir: alias, dbPath: live }), []);
  assert.equal(existsSync(live), true);
});

// ---- D2: o caminho de erro não pode apagar o backup VÁLIDO de outro processo ----
test('D2: destino já ocupado (outro processo) — o backup ALHEIO sobrevive e o nosso ganha outro nome', () => {
  const dir = sub('d2');
  const src = path.join(sub('d2-src'), 'crawler.db');
  makeDb(src, 42);
  const seed = createBackup({ reason: 'semente', dbPath: src, dir });
  assert.ok(seed);

  // Simula o OUTRO processo: ocupa antecipadamente TODOS os nomes que o próximo createBackup
  // poderia escolher neste e nos próximos segundos, com backups VÁLIDOS (42 artigos cada).
  const alheios = [];
  for (const d of [0, 1000, 2000]) {
    const alien = path.join(dir, `crawler-${stampOf(new Date(Date.now() + d))}-reset.db`);
    copyFileSync(seed.path, alien);
    alheios.push({ path: alien, bytes: statSync(alien).size });
  }

  const meu = createBackup({ reason: 'reset', dbPath: src, dir });
  assert.ok(meu, 'o nosso backup FOI criado, apesar da colisão');
  assert.equal(
    alheios.some((a) => a.path === meu.path),
    false,
    'não reaproveitamos o nome de ninguém',
  );
  assert.match(path.basename(meu.path), /-reset-\d+\.db$/, 'a colisão vira sufixo -2/-3...');
  assert.equal(meu.articles, 42);
  for (const a of alheios) {
    assert.equal(existsSync(a.path), true, `BACKUP DO OUTRO PROCESSO SOBREVIVEU? ${a.path}`);
    assert.equal(statSync(a.path).size, a.bytes, 'e intacto (byte a byte)');
    assert.equal(countArticles(a.path), 42, 'e ainda com os 42 artigos');
  }
  // Nenhum temporário fica para trás.
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.endsWith('.tmp')),
    [],
  );
});

// ---- D3: retenção inválida cai no DEFAULT (10), nunca em 1 ----
test('D3: keep inválido cai no DEFAULT 10 — NUNCA em 1 (um typo não pode derrubar a retenção)', () => {
  for (const [i, keep] of [['abc'], [-5], [' '], [0], [Number.NaN], [null]].entries()) {
    const dir = sub(`d3-${i}`);
    const src = path.join(sub('d3-src'), `s${i}.db`);
    makeDb(src, 3);
    for (let n = 0; n < 12; n++) assert.ok(createBackup({ reason: `c${n}`, dbPath: src, dir }));
    assert.equal(listBackups(dir).length, 12);
    const { value: removed, lines } = captureLogs(() => pruneBackups({ keep: keep[0], dir, dbPath: path.join(TMP, 'nao-existe.db') }));
    assert.equal(removed.length, 2, `keep=${JSON.stringify(keep[0])} deveria manter 10, não ${12 - removed.length}`);
    assert.equal(listBackups(dir).length, 10, 'sobraram 10 cópias (o default), não 1');
    assert.ok(
      lines.some((l) => /keep inválido/.test(l)),
      `aviso ausente para ${JSON.stringify(keep[0])}`,
    );
  }
});

test('D3(config): BACKUP_KEEP inválido no ambiente resolve para 10 com aviso (não para 1)', () => {
  const home = sub('d3-cfg-home');
  const url = pathToFileURL(path.resolve('src/config.js')).href;
  const script = `const c = await import(${JSON.stringify(url)});\nprocess.stdout.write('KEEP=' + c.BACKUP_KEEP + '\\n');`;
  for (const raw of ['abc', '-5', '0', ' ', '10', '3']) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, NC_HOME: home, BACKUP_KEEP: raw },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `config não carregou com BACKUP_KEEP=${raw}: ${r.stderr}`);
    const got = Number(/KEEP=(\d+)/.exec(r.stdout)?.[1]);
    const esperado = raw.trim() && Number(raw) >= 1 ? Math.floor(Number(raw)) : 10;
    assert.equal(got, esperado, `BACKUP_KEEP=${JSON.stringify(raw)} -> ${got}`);
    const avisou = /BACKUP_KEEP inválido/.test(r.stdout + r.stderr);
    assert.equal(avisou, esperado === 10 && Number(raw) !== 10, `aviso errado para ${JSON.stringify(raw)}`);
  }
});

// ---- D4: diagnóstico honesto (ler != corromper) ----
test('D4: a mensagem distingue "não consegui LER" de "corrompido ou sem schema"', (t) => {
  if (process.getuid?.() === 0) return t.skip('rodando como root: chmod não bloqueia leitura');
  const dir = sub('d4');
  const src = path.join(sub('d4-src'), 'crawler.db');
  makeDb(src, 9);
  chmodSync(src, 0);
  try {
    const { value, lines } = captureLogs(() => createBackup({ reason: 'reset', dbPath: src, dir }));
    assert.equal(value, null);
    assert.ok(lines.some((l) => /não consegui LER/.test(l)), `esperava falha de LEITURA: ${lines.join(' | ')}`);
    assert.equal(
      lines.some((l) => /schema não respondeu/.test(l)),
      false,
      'sem permissão de leitura NÃO é "corrompido" — o diagnóstico não pode mentir',
    );
  } finally {
    chmodSync(src, 0o600);
  }

  // O outro lado: arquivo que ABRE mas não é banco -> aí sim "corrompido ou sem schema".
  const junk = path.join(sub('d4-src'), 'corrompido.db');
  writeFileSync(junk, 'isto não é um banco SQLite');
  const { value, lines } = captureLogs(() => createBackup({ reason: 'reset', dbPath: junk, dir }));
  assert.equal(value, null);
  assert.ok(lines.some((l) => /schema não respondeu/.test(l)), `esperava diagnóstico de corrupção: ${lines.join(' | ')}`);
});

// ---- D5: `articles` descreve o BACKUP, não a origem ----
test('D5: `articles` descreve o ARQUIVO GERADO, não a origem no instante T', () => {
  const dir = sub('d5');
  const src = path.join(sub('d5-src'), 'crawler.db');
  const d = makeDb(src, 10);
  const r = createBackup({ reason: 'reset', dbPath: src, dir });
  assert.ok(r);
  // A origem CRESCE depois do backup (é o que um crawl concorrente faz).
  const ins = d.prepare('INSERT INTO articles (url, title) VALUES (?, ?)');
  d.transaction(() => {
    for (let i = 500; i < 505; i++) ins.run(`https://x/${i}`, `t${i}`);
  })();
  assert.equal(countArticles(src), 15, 'a origem agora tem 15');
  assert.equal(r.articles, 10, 'o número reportado é o do BACKUP, não o da origem');
  assert.equal(countArticles(r.path), 10);
  assert.equal(listBackups(dir)[0].articles, 10);
});

// ---- D6: "0 artigos" != "0 dados" ----
test('D6: 0 artigos MAS com sources/selectors/llm_usage GERA backup (é o banco do usuário hoje)', () => {
  const dir = sub('d6');
  const src = path.join(sub('d6-src'), 'crawler.db');
  const d = makeDbNoArticles(src);
  d.exec(`INSERT INTO sources (name, base_url) VALUES ('JS Weekly', 'https://javascriptweekly.com/issues');
          INSERT INTO selectors (template_sig, link_selector) VALUES ('sig', 'a.issue');
          INSERT INTO llm_usage (stage, cost) VALUES ('classify', 12.0);`);

  const r = createBackup({ reason: 'reset', dbPath: src, dir });
  assert.ok(r, '0 artigos NÃO pode dispensar o backup: selectors custaram IA e llm_usage é o ledger');
  assert.equal(r.articles, 0);
  const c = new Database(r.path, { readonly: true, fileMustExist: true });
  assert.equal(c.prepare('SELECT count(*) AS c FROM sources').get().c, 1);
  assert.equal(c.prepare('SELECT count(*) AS c FROM selectors').get().c, 1);
  assert.equal(c.prepare('SELECT cost AS x FROM llm_usage').get().x, 12);
  c.close();

  // Controle: TODAS as tabelas vazias -> aí sim é dispensado.
  const vazio = path.join(sub('d6-src'), 'vazio.db');
  makeDbNoArticles(vazio);
  const dir2 = sub('d6-vazio');
  const { value, lines } = captureLogs(() => createBackup({ reason: 'reset', dbPath: vazio, dir: dir2 }));
  assert.equal(value, null);
  assert.ok(lines.some((l) => /sem dado nenhum/.test(l)), lines.join(' | '));
  assert.deepEqual(dbFiles(dir2), []);
});

// ---- retenção limpa sidecars órfãos ----
test('a poda leva o -wal/-shm do backup removido junto (nada de órfão na pasta)', () => {
  const dir = sub('sidecars');
  const src = path.join(sub('sidecars-src'), 'crawler.db');
  makeDb(src, 4);
  const velho = createBackup({ reason: 'velho', dbPath: src, dir });
  const novo = createBackup({ reason: 'novo', dbPath: src, dir });
  utimesSync(velho.path, 1, 1);
  writeFileSync(`${velho.path}-wal`, 'sobra de wal');
  writeFileSync(`${velho.path}-shm`, 'sobra de shm');

  assert.deepEqual(pruneBackups({ keep: 1, dir, dbPath: path.join(TMP, 'nao-existe.db') }), [velho.path]);
  assert.equal(existsSync(`${velho.path}-wal`), false, '-wal órfão foi junto');
  assert.equal(existsSync(`${velho.path}-shm`), false, '-shm órfão foi junto');
  assert.equal(existsSync(novo.path), true);
});

// ---- D7: o schema REAL (fts5 external-content + vec0) sobrevive a backup + restore ----
// A premissa de MAIOR risco do módulo: `VACUUM INTO` copia tabelas virtuais e suas shadow tables.
// Um schema de brinquedo (articles(id,url,title)) não exercita NADA disso — uma regressão aqui
// sairia calada e o usuário só descobriria na hora de restaurar. Este teste roda o schema de
// verdade (src/db.js), popula, faz o backup, RESTAURA por cima e cobra as duas buscas.
test('D7: schema REAL — depois de backup+restore, o FTS responde a MATCH e o vec responde a KNN', async () => {
  const { db, VEC_OK } = await import('../src/db.js');
  assert.equal(VEC_OK, true, 'sqlite-vec precisa carregar: sem ele o teste não prova o KNN');
  assert.equal(path.resolve(DB_PATH), path.join(TMP, 'crawler.db'), 'schema real, mas em NC_HOME de teste');

  db.exec(`INSERT INTO sources (name, base_url) VALUES ('S', 'https://s');
           INSERT INTO articles (source_id, url, title, content)
             VALUES (1, 'https://a/1', 'Rust async runtime', 'tokio scheduler internals');
           INSERT INTO articles (source_id, url, title, content)
             VALUES (1, 'https://a/2', 'Python packaging', 'uv resolver notes');`);
  const embed = (i) => {
    const v = new Float32Array(EMBED_DIM);
    v[i] = 1;
    return Buffer.from(v.buffer);
  };
  const insVec = db.prepare('INSERT INTO articles_vec(rowid, embedding) VALUES (?, ?)');
  insVec.run(1n, embed(0));
  insVec.run(2n, embed(1));
  assert.deepEqual(
    db.prepare(`SELECT rowid FROM articles_fts WHERE articles_fts MATCH 'tokio'`).all(),
    [{ rowid: 1 }],
    'FTS responde ANTES do backup',
  );

  const dir = sub('d7-backups');
  const r = createBackup({ reason: 'reset', dbPath: DB_PATH, dir });
  assert.ok(r, 'backup do banco REAL');
  assert.equal(r.articles, 2);

  // RESTORE por cima: fecha a conexão viva e troca o arquivo. Os sidecars do banco antigo TÊM que
  // sair junto — um -wal remanescente seria aplicado por cima do arquivo restaurado (é a pegadinha
  // que a onda 3 precisa respeitar ao implementar o `restore`).
  db.close();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) rmSync(f, { force: true });
  copyFileSync(r.path, DB_PATH);

  const restored = new Database(DB_PATH, { fileMustExist: true });
  loadVec(restored);
  try {
    assert.equal(restored.prepare('SELECT count(*) AS c FROM articles').get().c, 2);
    assert.deepEqual(
      restored.prepare(`SELECT rowid FROM articles_fts WHERE articles_fts MATCH 'tokio'`).all(),
      [{ rowid: 1 }],
      'FTS MATCH responde DEPOIS da restauração',
    );
    assert.deepEqual(
      restored.prepare(`SELECT rowid FROM articles_fts WHERE articles_fts MATCH 'resolver'`).all(),
      [{ rowid: 2 }],
    );
    const knn = restored
      .prepare('SELECT rowid AS id, distance FROM articles_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 2')
      .all(embed(1));
    assert.equal(knn.length, 2, 'o KNN responde DEPOIS da restauração');
    assert.equal(knn[0].id, 2, 'e devolve o vizinho certo');
    assert.ok(knn[0].distance < 1e-5, `distância do vizinho exato: ${knn[0].distance}`);
    // As triggers do FTS continuam vivas no arquivo restaurado (external-content é o caso frágil).
    restored.exec(`INSERT INTO articles (source_id, url, title, content) VALUES (1, 'https://a/3', 'Zig comptime', 'comptime metaprogramming')`);
    assert.equal(restored.prepare(`SELECT count(*) AS c FROM articles_fts WHERE articles_fts MATCH 'comptime'`).get().c, 1);
  } finally {
    restored.close();
  }
});
