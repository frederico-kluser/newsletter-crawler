// Backup do banco SQLite: cópia CONSISTENTE antes de TODA operação destrutiva.
//
// Por que existe: o banco do usuário (~/.newsletter-crawler/crawler.db) já foi apagado DUAS vezes
// por um `reset` disparado sem querer na TUI (logs ui-2026-08-25T22-01-44 e ui-2026-09-01T03-16-20);
// o de 01/09 levou 3249 artigos e ~US$ 12 de chamadas de LLM 1min45 depois de a coleta terminar.
// A regra do usuário é "nunca recomece do zero": este módulo torna reset/purge/remove REVERSÍVEIS.
//
// Por que `VACUUM INTO` e NÃO copyFileSync: o banco roda em `journal_mode = WAL` (db.js), então o
// arquivo .db sozinho pode estar VAZIO — todo o dado recém-gravado vive no -wal até o checkpoint
// (medido: 500 artigos commitados => crawler.db com 4096 bytes e 41 KB no -wal). Copiar só o .db
// produziria um backup sem nada; copiar os três arquivos (.db/-wal/-shm) sem coordenação sai
// inconsistente. `VACUUM INTO` roda DENTRO de uma transação de leitura do SQLite: enxerga o WAL
// commitado, ignora escrita em voo não commitada e escreve um arquivo único já checkpointado
// (medido: o arquivo gerado sai em `journal_mode = delete`, então LER um backup não cria sidecar).
//
// REGRA DE OURO deste módulo (aprendida numa revisão que o pegou apagando o banco vivo): ele só
// pode APAGAR arquivo que ELE mesmo criou. Toda deleção passa por três camadas — nome tem que
// casar o NAME_RE dos nossos backups, caminho REAL não pode ser o DB_PATH nem sidecar dele, e
// BACKUP_DIR igual ao diretório do banco vivo desliga a retenção inteira.
//
// Tudo aqui é FAIL-OPEN e BARULHENTO: falhou (disco cheio, permissão, banco corrompido) -> avisa
// via warn/errorLog e devolve null; QUEM CHAMA decide se aborta a operação destrutiva.
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  existsSync,
  linkSync,
} from 'node:fs';
import path from 'node:path';
import { BACKUP_DIR, BACKUP_KEEP, BACKUP_KEEP_DEFAULT, BACKUP_MIN_INTERVAL_MS, DB_PATH } from './config.js';
import { log, warn, errorLog } from './util.js';

export { BACKUP_DIR };

// crawler-20260905T145737Z-reset.db  (e -2, -3... quando dois backups caem no mesmo segundo)
const NAME_RE = /^crawler-(\d{8}T\d{6}Z)-(.+?)(?:-(\d+))?\.db$/;
// Teto de tentativas de nome no mesmo segundo (loop de colisão nunca vira laço infinito).
const MAX_NAME_TRIES = 50;
// Sufixos dos arquivos que o SQLite mantém AO LADO do .db — intocáveis quando o .db é o banco vivo.
const SIDECARS = ['-wal', '-shm'];
// Mesmo timeout do db.js: dois `ncrawl` podem compartilhar o banco, e uma conexão sem busy_timeout
// falharia na hora com SQLITE_BUSY em vez de esperar o outro escritor.
const BUSY_TIMEOUT_MS = 5000;
// Tabelas de DADOS do crawler (db.js). "0 artigos" NÃO é "0 dados": selectors saíram de chamadas
// de IA que custaram dinheiro e llm_usage é o ledger desse gasto — um banco assim PRECISA de
// backup antes de um reset. Shadow tables de fts5/vec0 ficam de fora de propósito: elas têm linhas
// de configuração mesmo num índice vazio e fariam todo banco parecer "cheio".
const DATA_TABLES = [
  'articles',
  'sources',
  'pages',
  'selectors',
  'frontier',
  'runs',
  'classifications',
  'article_tags',
  'classification_uncovered',
  'llm_usage',
  'events',
  'searches',
];

// Tamanho legível no log (MB no banco real, KB nas cópias pequenas — "0.0 MB" não diz nada).
const human = (bytes) => {
  const b = Number(bytes) || 0;
  return b >= 1024 * 1024 ? `${(b / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
};

/** 2026-09-05T14:57:37.123Z -> 20260905T145737Z (ISO compacto, ordenável, sem caractere proibido). */
function compactStamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Motivo -> pedaço seguro de nome de arquivo ('reset', 'purge-hacker-news', 'manual'). */
function sanitizeReason(reason) {
  return (
    String(reason ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'manual'
  );
}

/** Nome canônico de um backup deste módulo (seq > 1 = colisão no mesmo segundo). */
const backupName = (stamp, reason, seq) =>
  seq > 1 ? `crawler-${stamp}-${reason}-${seq}.db` : `crawler-${stamp}-${reason}.db`;

/** É um arquivo criado POR ESTE módulo? Só o que passa aqui pode ser apagado pela retenção. */
export function isBackupName(name) {
  return NAME_RE.test(String(name ?? ''));
}

/** Caminho REAL (segue symlink) — `path.resolve` sozinho não resolve link, e um backup que é
 *  symlink p/ o banco vivo passaria despercebido pela proteção. Arquivo ainda inexistente: resolve
 *  o diretório (que pode ser link) e cola o basename. Nunca lança. */
function realPath(p) {
  const abs = path.resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    /* ainda não existe: tenta pelo diretório */
  }
  try {
    return path.join(realpathSync(path.dirname(abs)), path.basename(abs));
  } catch {
    return abs;
  }
}

/** Dois caminhos apontam para o MESMO diretório (depois de resolver symlinks)? */
const sameDir = (a, b) => realPath(a) === realPath(b);

/** Banco vivo + sidecars, em caminho absoluto E real: o conjunto que a retenção jamais toca. */
function guardedPaths(dbPath) {
  const set = new Set();
  const abs = path.resolve(dbPath);
  for (const p of [abs, ...SIDECARS.map((s) => abs + s)]) {
    set.add(p);
    set.add(realPath(p));
  }
  return set;
}

/** Apaga best-effort um arquivo NOSSO (temporário/sidecar de backup). Ausente = ok, nunca lança. */
function removeQuietly(file) {
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    /* melhor esforço: sobra de arquivo é ruído, exceção aqui seria perda de backup */
  }
}

/**
 * Cria o diretório de backups SOB DEMANDA (nunca no import — config.js já paga um mkdirSync no
 * topo e o import de um módulo não deve tocar o filesystem além disso). Retorna o caminho, ou
 * null se o filesystem recusar (somente-leitura, caminho ocupado por um arquivo, disco cheio).
 */
export function ensureBackupDir(dir = BACKUP_DIR) {
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch (e) {
    errorLog(`backup: não consegui criar o diretório ${dir} (${e.message}) — backup NÃO criado.`);
    return null;
  }
}

/** Abre um .db em SOMENTE-LEITURA com busy_timeout (multiprocesso: db.js:14-16). Lança se o
 *  arquivo não abrir — quem chama traduz para a mensagem certa. */
function openReadonly(file) {
  const conn = new Database(file, { readonly: true, fileMustExist: true });
  try {
    conn.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch {
    /* pragma é otimização de espera; a conexão já serve sem ele */
  }
  return conn;
}

/** Abre a ORIGEM do backup. SEMPRE somente-leitura: este módulo NUNCA escreve no banco do usuário
 *  (uma abertura leitura/escrita pode disparar recuperação/checkpoint do WAL no arquivo que
 *  estamos justamente tentando proteger). Medido: onde o modo readonly falha — diretório sem
 *  permissão de escrita e com -wal vivo — a abertura leitura/escrita falha igual, então o antigo
 *  fallback era código morto que só servia para produzir um diagnóstico errado. */
const openSource = openReadonly;

/** Conta artigos numa conexão já aberta; null se a tabela não existe/não responde. */
function countArticlesIn(conn) {
  try {
    const n = Number(conn.prepare('SELECT count(*) AS c FROM articles').get()?.c);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Quantos artigos um arquivo .db contém — é o que torna o backup AUDITÁVEL (e é por isto que o
 * restore escolhe entre duas cópias). Abre a conexão em READONLY, conta e fecha.
 * À prova de arquivo corrompido/sem schema/ausente: devolve null e NUNCA lança.
 * (SQL fora do `stmts` do db.js de propósito: aqui o alvo é OUTRO arquivo de banco — uma cópia —,
 *  não a conexão viva da aplicação; o stmts do db.js é preparado contra o banco em uso.)
 */
export function countArticles(dbFile) {
  let conn = null;
  try {
    conn = openReadonly(dbFile);
    return countArticlesIn(conn);
  } catch {
    return null; // arquivo ausente, não-SQLite, truncado ou sem permissão
  } finally {
    try {
      conn?.close();
    } catch {
      /* já fechado / nunca abriu */
    }
  }
}

/**
 * O que o arquivo CONTÉM, do ponto de vista do backup: { readable, tables, filled, articles }.
 * `readable=false` = abriu mas o schema não responde (corrompido / não é SQLite) — é DIFERENTE de
 * "não consegui abrir o arquivo", e a mensagem precisa distinguir os dois: diagnóstico mentiroso
 * num módulo de recuperação faz o usuário tomar a decisão errada na pior hora possível.
 * `filled` usa EXISTS (O(1)) — só interessa se HÁ linha, não quantas.
 */
function inspectDb(conn) {
  let tables = [];
  try {
    const ph = DATA_TABLES.map(() => '?').join(',');
    tables = conn
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${ph})`)
      .all(...DATA_TABLES)
      .map((r) => r.name);
  } catch {
    return { readable: false, tables: [], filled: [], articles: null };
  }
  const filled = [];
  for (const t of tables) {
    try {
      if (conn.prepare(`SELECT EXISTS(SELECT 1 FROM "${t}") AS x`).get()?.x) filled.push(t);
    } catch {
      /* tabela ilegível não prova vazio nem cheio — segue (na dúvida, o backup acontece) */
    }
  }
  return { readable: true, tables, filled, articles: countArticlesIn(conn) };
}

/**
 * Publica o temporário JÁ GRAVADO no primeiro nome livre, de forma ATÔMICA: `link` cria o nome
 * novo ou falha com EEXIST — não existe janela entre "checar" e "criar", então dois processos no
 * mesmo segundo nunca se sobrescrevem (`rename` sobrescreveria em silêncio o backup do outro).
 * Filesystem sem hardlink cai p/ rename com checagem prévia (janela mínima, documentada).
 * Retorna o caminho final ou null.
 */
function publishBackup(tmp, dir, stamp, reason) {
  for (let seq = 1; seq <= MAX_NAME_TRIES; seq++) {
    const full = path.join(dir, backupName(stamp, reason, seq));
    try {
      linkSync(tmp, full);
      return full;
    } catch (e) {
      if (e?.code === 'EEXIST') continue; // nome tomado (por nós ou por outro processo): próximo
      if (existsSync(full)) continue; // sem hardlink E destino ocupado: NUNCA sobrescrever
      try {
        renameSync(tmp, full);
        return full;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Cópia CONSISTENTE do banco (VACUUM INTO) em BACKUP_DIR.
 * - `reason`: motivo, vai no nome do arquivo ('reset' | 'purge' | 'remove' | 'crawl' | 'manual').
 * - `dbPath`: banco de origem (default DB_PATH); `dir`: destino (default BACKUP_DIR).
 * - `minIntervalMs` (>0): backup PERIÓDICO — pula se já existe cópia mais nova que isto.
 *   Operação destrutiva NÃO passa este parâmetro: ela sempre copia.
 * Banco sem NENHUMA linha em NENHUMA tabela de dados não gera backup (copiar o nada só polui a
 * lista); qualquer linha em qualquer tabela — inclusive só `sources`/`selectors`/`llm_usage`, com
 * ZERO artigos — vira backup. Retorna { path, name, bytes, articles, reason, elapsedMs } ou null
 * (com aviso) em qualquer falha — NUNCA lança. `articles` descreve o BACKUP GERADO, não a origem.
 */
export function createBackup({ reason = 'manual', dbPath = DB_PATH, dir = BACKUP_DIR, minIntervalMs = 0 } = {}) {
  const started = Date.now();
  const why = sanitizeReason(reason);

  if (!existsSync(dbPath)) {
    warn(`backup: banco não encontrado em ${dbPath} — nada a copiar.`);
    return null;
  }

  // Intervalo mínimo ANTES de abrir a origem: o backup periódico que vai ser pulado não precisa
  // nem encostar no banco do usuário.
  const interval = Number(minIntervalMs);
  if (Number.isFinite(interval) && interval > 0) {
    const last = latestBackup(dir);
    if (last && Date.now() - last.mtimeMs < interval) {
      log(`backup (${why}): já existe cópia recente (${last.name}) — pulando (intervalo mínimo ${interval}ms).`);
      return null;
    }
  }

  let conn = null;
  try {
    conn = openSource(dbPath);
  } catch (e) {
    errorLog(
      `backup (${why}): não consegui LER ${dbPath} (${e.message}) — sem permissão, arquivo em uso ` +
        `exclusivo ou não é um banco SQLite. Isto é falha de LEITURA, não prova de corrupção. Backup NÃO criado.`,
    );
    return null;
  }

  try {
    const info = inspectDb(conn);
    if (!info.readable) {
      errorLog(`backup (${why}): ${dbPath} abriu mas o schema não respondeu (corrompido ou sem schema) — backup NÃO criado.`);
      return null;
    }
    if (info.tables.length && !info.filled.length) {
      log(`backup (${why}): banco sem dado nenhum (${info.tables.length} tabela(s), todas vazias) — dispensado.`);
      return null;
    }

    const target = ensureBackupDir(dir);
    if (!target) return null;
    if (sameDir(target, path.dirname(dbPath))) {
      warn(
        `backup: BACKUP_DIR (${target}) é o MESMO diretório do banco vivo (${dbPath}) — configuração PERIGOSA: ` +
          `a retenção fica DESLIGADA. Aponte BACKUP_DIR para uma pasta só de backups.`,
      );
    }

    // Grava num TEMPORÁRIO e só depois publica: o destino final nunca vê arquivo pela metade, e o
    // caminho de erro só pode apagar arquivo NOSSO (pid + aleatório no nome). Sem isso, dois
    // processos no mesmo segundo escolhiam o MESMO nome e o catch do perdedor apagava o backup
    // VÁLIDO do vencedor. Sufixo .tmp (não .db) => invisível para listBackups.
    const stamp = compactStamp();
    const tmp = path.join(target, `.crawler-${stamp}-${why}-${process.pid}-${randomBytes(4).toString('hex')}.db.tmp`);
    try {
      // Parâmetro ligado: o caminho pode conter aspas/espaços e VACUUM INTO aceita expressão.
      conn.prepare('VACUUM INTO ?').run(tmp);
    } catch (e) {
      errorLog(`backup (${why}): FALHOU ao copiar ${dbPath} (${e.message}) — o banco NÃO foi copiado.`);
      removeQuietly(tmp); // só o NOSSO temporário; um destino alheio jamais é tocado
      return null;
    }

    const file = publishBackup(tmp, target, stamp, why);
    removeQuietly(tmp); // sobra do hardlink (no fallback por rename o arquivo já saiu daqui)
    if (!file) {
      errorLog(`backup (${why}): não achei nome livre em ${target} (${MAX_NAME_TRIES} tentativas) — backup NÃO criado.`);
      return null;
    }

    let bytes = 0;
    try {
      bytes = statSync(file).size;
    } catch {
      /* o arquivo existe (o VACUUM não lançou); tamanho é informativo */
    }
    // Conta do ARQUIVO GERADO, não da origem: com escrita concorrente a contagem da origem no
    // instante T já não descreve o que está dentro do backup.
    const articles = countArticles(file) ?? info.articles;
    const elapsedMs = Date.now() - started;
    log(`backup (${why}): ${file} — ${articles ?? '?'} artigos, ${human(bytes)}, ${elapsedMs}ms.`);
    return { path: file, name: path.basename(file), bytes, articles, reason: why, elapsedMs };
  } finally {
    try {
      conn?.close();
    } catch {
      /* já fechado */
    }
  }
}

// Mais NOVO primeiro. mtime manda; empate (mesmo milissegundo) desempata pelo carimbo do nome e
// pelo contador de colisão, p/ a ordem ser determinística mesmo em teste rápido.
const byNewest = (a, b) =>
  b.mtimeMs - a.mtimeMs ||
  String(b.stamp || '').localeCompare(String(a.stamp || '')) ||
  b.seq - a.seq ||
  String(b.name).localeCompare(String(a.name));

/**
 * Backups existentes, do mais NOVO ao mais ANTIGO:
 * { path, name, bytes, mtime, mtimeMs, articles, reason, stamp, seq }.
 * SÓ entram arquivos que casam o NAME_RE — ou seja, cópias criadas por ESTE módulo. Qualquer outro
 * `.db` do diretório (a começar pelo `crawler.db` VIVO, quando alguém aponta BACKUP_DIR para a
 * pasta do banco) fica de fora: o que não está na lista não pode ser apagado pela retenção.
 * `articles` sai null quando o arquivo não abre (corrompido/truncado) — a listagem nunca lança,
 * e um arquivo ilegível continua VISÍVEL (some da lista seria pior: o usuário não saberia dele).
 */
export function listBackups(dir = BACKUP_DIR) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // diretório ainda não existe (nenhum backup) ou ilegível
  }
  const out = [];
  for (const name of names) {
    const m = NAME_RE.exec(name);
    if (!m) continue; // -wal/-shm, temporários, banco vivo, lixo: não são backups nossos
    const full = path.join(dir, name);
    let st = null;
    try {
      st = statSync(full);
    } catch {
      continue; // sumiu entre o readdir e o stat
    }
    if (!st.isFile()) continue;
    out.push({
      path: full,
      name,
      bytes: st.size,
      mtime: st.mtime,
      mtimeMs: st.mtimeMs,
      articles: countArticles(full),
      reason: m[2],
      stamp: m[1],
      seq: m[3] ? Number(m[3]) : 1,
    });
  }
  out.sort(byNewest);
  return out;
}

/** Cópia mais RECENTE (ou null). É o default do restore: "volta pro estado de antes". */
export function latestBackup(dir = BACKUP_DIR) {
  return listBackups(dir)[0] || null;
}

/** Entre entradas JÁ ordenadas (nova -> velha), a com MAIS artigos; empate fica com a mais nova. */
function richest(list) {
  let best = null;
  for (const b of list) {
    if (typeof b.articles !== 'number' || b.articles <= 0) continue; // ilegível/vazia nunca é "a melhor"
    if (!best || b.articles > best.articles) best = b;
  }
  return best;
}

/** Cópia com MAIS artigos (ou null). É a que o restore oferece quando o usuário quer o acervo
 *  mais completo, não o estado mais recente — os dois conceitos podem divergir. */
export function bestBackup(dir = BACKUP_DIR) {
  return richest(listBackups(dir));
}

/** `keep` inválido ('abc', '-5', ' ', 0) cai no DEFAULT, NUNCA em 1: retenção que degrada para
 *  MENOS cópias por causa de um typo seria exatamente a armadilha que este módulo existe p/ evitar. */
function normalizeKeep(keep) {
  const n = Number(keep);
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  warn(`backup: keep inválido (${JSON.stringify(keep)}) — usando o default ${BACKUP_KEEP_DEFAULT} (a retenção nunca degrada para menos cópias).`);
  return BACKUP_KEEP_DEFAULT;
}

/**
 * Retenção: mantém as `keep` cópias mais recentes e apaga o excedente.
 * DUAS cópias são INTOCÁVEIS, aconteça o que acontecer: a mais RECENTE e a com MAIS ARTIGOS.
 * A retenção não pode virar mais uma forma de perder dado — é a razão de este módulo existir.
 * TRÊS camadas impedem que a poda toque no banco VIVO (uma revisão pegou este código apagando o
 * `crawler.db` do usuário quando BACKUP_DIR=. ):
 *   (a) só apaga nome que casa o NAME_RE dos backups deste módulo (listBackups já filtra; aqui é
 *       cinto e suspensório — a lista pode chegar de outro caminho amanhã);
 *   (b) nunca apaga o DB_PATH nem seus sidecars, comparado por caminho REAL (pega symlink);
 *   (c) BACKUP_DIR no mesmo diretório do banco vivo => RECUSA podar (ver abaixo).
 * Retorna os caminhos REMOVIDOS (falha ao apagar vira aviso e o arquivo fica).
 */
export function pruneBackups({ keep = BACKUP_KEEP, dir = BACKUP_DIR, dbPath = DB_PATH } = {}) {
  const k = normalizeKeep(keep);
  // (c) Config perigosa: RECUSAR é melhor que "podar com cuidado". Não apagar nada custa disco;
  // apagar demais já custou o acervo do usuário duas vezes. O backup em si continua funcionando —
  // o usuário perde a limpeza automática, não a rede de proteção.
  if (sameDir(dir, path.dirname(dbPath))) {
    errorLog(
      `backup: retenção RECUSADA — BACKUP_DIR (${dir}) é o mesmo diretório do banco vivo (${dbPath}). ` +
        `NADA foi apagado. Aponte BACKUP_DIR para uma pasta só de backups.`,
    );
    return [];
  }

  const list = listBackups(dir);
  if (list.length <= k) return [];

  const keepPaths = new Set();
  keepPaths.add(list[0].path); // a mais recente
  const best = richest(list);
  if (best) keepPaths.add(best.path); // a mais rica

  const guarded = guardedPaths(dbPath);
  const removed = [];
  for (const b of list.slice(k)) {
    if (keepPaths.has(b.path)) continue;
    if (!isBackupName(b.name)) {
      warn(`backup: ${b.name} não é um backup deste módulo — NÃO apagado.`); // (a)
      continue;
    }
    if (guarded.has(path.resolve(b.path)) || guarded.has(realPath(b.path))) {
      errorLog(`backup: RECUSEI apagar ${b.path} — resolve para o BANCO VIVO (${dbPath}) ou um sidecar dele.`); // (b)
      continue;
    }
    try {
      unlinkSync(b.path);
      removed.push(b.path);
      for (const s of SIDECARS) removeQuietly(b.path + s); // -wal/-shm órfãos vão junto
    } catch (e) {
      warn(`backup: não consegui apagar ${b.name} (${e.message}) — mantido.`);
    }
  }
  if (removed.length) {
    log(`backup: retenção keep=${k} apagou ${removed.length} cópia(s); ${list.length - removed.length} mantida(s).`);
  }
  return removed;
}

/** Chegou a hora de um backup PERIÓDICO? (sem nenhum backup, sempre sim). Quem agenda o backup
 *  de rotina consulta isto p/ não gerar uma cópia quase idêntica a cada minuto. */
export function isBackupDue({ minIntervalMs = BACKUP_MIN_INTERVAL_MS, dir = BACKUP_DIR } = {}) {
  const iv = Number(minIntervalMs);
  if (!Number.isFinite(iv) || iv <= 0) return true;
  const last = latestBackup(dir);
  if (!last) return true;
  return Date.now() - last.mtimeMs >= iv;
}
