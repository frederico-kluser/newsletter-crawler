// RECUPERAÇÃO pela CLI: `ncrawl restore` (acervo de volta do histórico do git), `ncrawl backup`
// (criar/listar/repor a partir de uma cópia do banco) e o BOOTSTRAP automático que faz uma base
// VAZIA se reconstruir sozinha antes de qualquer comando útil.
//
// Por que um módulo próprio e não `commands.js`: o comando `restore` é "efeito de fora pra fora"
// (git + banco + backup) e a regra de decisão do bootstrap precisa ser testável SEM subir o
// grafo inteiro do crawler — é a mesma separação que `deploy.js` já fez (extending-the-crawler).
//
// A REGRA DO USUÁRIO, literal: "nunca recomece do zero". O acervo deixou de morar só no SQLite
// local: ele está VERSIONADO em `webapp/public/data` (src/restore.js). Portanto um clone novo do
// repositório JÁ TEM os dados — só falta alguém colocá-los no banco. É o que o bootstrap faz.
//
// Nada aqui pode derrubar o comando que chamou: `maybeAutoRestore` é fail-open e barulhento (todo
// pulo é logado com o motivo), e as trocas de arquivo do `backup restore` só acontecem depois de
// uma cópia de segurança do que está vivo.
import { copyFileSync, existsSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { AUTO_RESTORE, BACKUP_DIR, DB_PATH, RESTORE_BODY_POLICY, ROOT } from './config.js';
import { bestBackup, countArticles as countArticlesIn, createBackup, latestBackup, listBackups, pruneBackups } from './backup.js';
import { backupBeforeDestructive } from './commands.js';
import { countArticles, db, stmts } from './db.js';
import { BODY_POLICIES, isGitRepo, isUnderTest, maybeAutoRestore, restoreFromGit } from './restore.js';
import { errorLog, log, warn } from './util.js';

// Sufixos que o SQLite mantém ao lado do .db em `journal_mode = WAL`. Um `-wal` sobrevivente é
// REAPLICADO por cima do arquivo que acabou de ser copiado — o backup restaurado voltaria a ser
// o banco velho. Apagar os três é parte da receita, não zelo.
const SIDECARS = ['-wal', '-shm'];

/** Flag booleana da CLI: ausente = undefined; presente = true (ou a string que veio depois). */
const flagOn = (v) => v !== undefined && v !== false && v !== 'false' && v !== '0';

/** Inteiro de flag (`--limit 50`); valor inválido/ausente cai no default, nunca em NaN. */
function intFlag(v, fallback = 0) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Contagem de artigos da base VIVA. Fail-open: banco ilegível responde "não está vazia" (na
 *  dúvida o bootstrap não escreve nada por cima). */
function liveArticles() {
  try {
    return countArticles();
  } catch {
    return -1;
  }
}

/** Há QUALQUER linha de dado no banco? Fail-SAFE: em erro responde "sim" (na dúvida, copia). */
function hasAnyData() {
  try {
    return Boolean(stmts.hasAnyData.get().x);
  } catch {
    return true;
  }
}

/** Caminho REAL (resolve symlink) p/ comparar arquivos. Nunca lança. */
function realPath(p) {
  try {
    return realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

// ---------------- bootstrap automático ----------------

/**
 * Comandos ÚTEIS que merecem uma base cheia. É uma ALLOWLIST de propósito (e não uma denylist):
 * um comando novo nasce SEM bootstrap e quem o adiciona decide conscientemente.
 *
 * Ficam de FORA, e o motivo importa:
 *   - `reset`/`purge`/`remove`: o restore desfaria no mesmo processo o que o usuário acabou de
 *     mandar apagar (o `printStatus()` no fim do `cmdReset` é justamente onde NÃO se pode fiar
 *     isto);
 *   - `key`/`limits`/`add`: configuração, não leitura do acervo — 12s de varredura do git no
 *     caminho de `ncrawl key set` seria hostil;
 *   - `deploy`: publica o que está no banco. Restaurar por baixo de um deploy transformaria um
 *     comando de publicação num comando de escrita no acervo, sem o usuário pedir;
 *   - `inspect`/`reclean`/`reextract`: auditoria/reprocessamento de uma run que ACABOU de rodar;
 *     base vazia ali é diagnóstico, não acidente.
 */
export const BOOTSTRAP_COMMANDS = new Set(['crawl', 'finish', 'search', 'web', 'export', 'ui', 'menu', 'status']);

/** O comando pede bootstrap? (puro — é a regra que os testes fixam) */
export function shouldBootstrap(cmd) {
  return Boolean(cmd) && BOOTSTRAP_COMMANDS.has(String(cmd));
}

/**
 * O GANCHO: chamado por src/index.js antes do dispatch (e antes do render da TUI). Base vazia +
 * snapshot no histórico do git ⇒ o acervo volta sozinho, em vez de o crawler recomeçar do zero
 * (~600 issues por fonte, horas e US$ de LLM).
 *
 * Desligado por `--no-restore` (flag) ou `CRAWLER_AUTO_RESTORE=false` (env, config.js) — nos dois
 * casos o motivo é LOGADO quando a base está vazia, senão "não funcionou" e "não precisou" ficam
 * indistinguíveis. Com a base CHEIA (o estado normal) o pulo é SILENCIOSO: repetir "a base já tem
 * artigos" em todo `ncrawl status` seria ruído puro.
 *
 * O aviso ANTES da varredura é obrigatório: `collectFromGit` leva ~12s no acervo real e um
 * silêncio desses no primeiro comando de um clone novo parece travamento.
 *
 * Retorna o resultado do `maybeAutoRestore` (`{ ran, skipped, ... }`), ou
 * `{ ran:false, skipped:'command' }` quando o comando não está na allowlist.
 */
export function bootstrapFromCli(cmd, flags = {}, { root = ROOT } = {}) {
  if (!shouldBootstrap(cmd)) return { ran: false, skipped: 'command', reason: `cli:${cmd || '-'}` };
  const enabled = AUTO_RESTORE && !flagOn(flags['no-restore']);
  const empty = liveArticles() === 0;
  if (enabled && empty && !isUnderTest() && process.env.NC_NO_AUTO_RESTORE !== '1' && isGitRepo(root)) {
    log(`base VAZIA — procurando o acervo no histórico do git (${root}); isso leva alguns segundos…`);
  }
  // `quiet` só na base cheia: ali o pulo é o comportamento esperado, não uma falha a diagnosticar.
  return maybeAutoRestore({ root, reason: `cli:${cmd}`, enabled, quiet: !empty });
}

// ---------------- ncrawl restore ----------------

/** Linhas do relatório de uma restauração (as MESMAS no dry-run e na execução real). Puro. */
export function restoreReportLines(res, { dryRun = false } = {}) {
  const r = res.report || {};
  const lines = [
    `${dryRun ? '[dry-run] ' : ''}histórico: ${r.commits ?? 0} commit(s) de dados em ${r.snapshots?.length ?? 0} snapshot(s)` +
      `${r.shallow ? ' (clone RASO: só o working tree)' : ''}${r.wipe ? ` · marcador de wipe ATIVO (${r.wipe.entries} entrada(s))` : ''}`,
    `${dryRun ? '[dry-run] ' : ''}união: ${r.articles ?? 0} artigo(s) únicos — ${r.withBody ?? 0} com corpo, ` +
      `${r.withSummary ?? 0} com resumo PT-BR, ${r.withTags ?? 0} com tags, ${r.withDate ?? 0} com data ` +
      `(política de corpo: ${r.bodyPolicy})`,
    `${dryRun ? '[dry-run] ' : ''}selecionados: ${res.selected} — ${res.keptId} manteriam o id do snapshot, ${res.freshId} ganhariam id novo`,
  ];
  if (dryRun) {
    lines.push('[dry-run] NADA foi escrito no banco. Rode sem --dry-run para aplicar.');
    return lines;
  }
  lines.push(
    `aplicado: ${res.inserted} artigo(s) repostos, ${res.tags} tag(s), ${res.classifications} classificação(ões), ` +
      `${res.frontier} URL(s) na frontier, ${res.pages} página(s), ${res.sources} fonte(s) — ${(res.ms / 1000).toFixed(1)}s`,
  );
  const skipped = Object.entries(res.skippedRows || {});
  if (skipped.length) lines.push(`ignorados: ${skipped.map(([k, v]) => `${v} por ${k}`).join(', ')}`);
  lines.push(`base: ${res.before.articles} → ${res.after.articles} artigo(s), ${res.before.tags} → ${res.after.tags} tag(s)`);
  return lines;
}

/**
 * `ncrawl restore [--dry-run] [--limit N] [--ref <ref>] [--since YYYY-MM-DD]
 *                 [--body-policy best|first|longest] [--no-marker] [--yes]`
 *
 * Reconstrói o acervo a partir dos snapshots commitados. Sobre base VIVA é ação séria (o restore
 * REPÕE, não sincroniza): exige `--yes` e tira BACKUP antes — sem backup, aborta.
 * `--no-marker` ignora a fronteira de wipe: é a escotilha de recuperação manual de quem apagou
 * por engano e QUER o acervo de volta (o marcador existe para o `reset` funcionar).
 */
export function cmdRestore(flags = {}) {
  const dryRun = flagOn(flags['dry-run']);
  const ref = typeof flags.ref === 'string' ? flags.ref : '--all';
  const since = typeof flags.since === 'string' ? flags.since : null;
  const limit = intFlag(flags.limit, 0);
  const useMarker = !flagOn(flags['no-marker']);
  const rawPolicy = typeof flags['body-policy'] === 'string' ? flags['body-policy'].toLowerCase() : RESTORE_BODY_POLICY;
  if (!BODY_POLICIES.has(rawPolicy)) {
    errorLog(`restore: --body-policy inválida ("${rawPolicy}") — use best | first | longest.`);
    process.exit(1);
  }

  if (!isGitRepo(ROOT)) {
    errorLog(
      `restore: ${ROOT} não é um repositório git — o acervo mora no histórico de webapp/public/data, ` +
        'e sem git não há o que restaurar. Use `ncrawl backup restore` se você tem uma cópia do banco.',
    );
    process.exit(1);
  }

  const existing = liveArticles();
  if (existing > 0 && !dryRun) {
    if (flags.yes !== true) {
      errorLog(
        `restore SOBRE BASE VIVA: já há ${existing} artigo(s) em ${DB_PATH}. O restore REPÕE o que está ` +
          'no snapshot (não sincroniza) e pode reaproveitar ids — confirme de propósito.',
      );
      errorLog('Veja antes o que ele faria:  ncrawl restore --dry-run');
      errorLog(`Confirme com:  ncrawl restore --yes${useMarker ? '' : ' --no-marker'}`);
      process.exit(1);
    }
    const guard = backupBeforeDestructive('restore');
    if (!guard.ok) {
      errorLog('restore ABORTADO: sem backup não se escreve por cima de uma base com dados. NADA foi tocado.');
      process.exit(1);
    }
  }

  if (!useMarker) {
    warn(
      'restore --no-marker: a fronteira do wipe foi IGNORADA — snapshots anteriores a um `reset` ' +
        'voltam para a base. É recuperação manual; é isso que você quer se apagou sem querer.',
    );
  }

  const res = restoreFromGit({
    root: ROOT,
    ref,
    dryRun,
    limit,
    since,
    bodyPolicy: rawPolicy,
    marker: useMarker ? undefined : null,
  });
  for (const line of restoreReportLines(res, { dryRun })) log(line);
  if (!res.selected) {
    warn(
      'restore: nenhum snapshot elegível no histórico' +
        (useMarker ? ' — se você acabou de dar um `reset`, o marcador de wipe está barrando (use --no-marker).' : '.'),
    );
  }
  return res;
}

// ---------------- ncrawl backup ----------------

/** Uma linha por cópia, do mais novo ao mais antigo. Puro (recebe a lista pronta). */
export function backupListLines(list, dir = BACKUP_DIR) {
  if (!list.length) return [`nenhum backup em ${dir}.`];
  const lines = [`${list.length} backup(s) em ${dir} (do mais novo ao mais antigo):`];
  for (const b of list) {
    const mb = b.bytes >= 1024 * 1024 ? `${(b.bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b.bytes / 1024))} KB`;
    lines.push(
      `  ${b.name}  ${b.articles === null ? 'ILEGÍVEL' : `${b.articles} artigo(s)`}  ${mb}  ` +
        `${b.mtime.toISOString()}  (${b.reason})`,
    );
  }
  return lines;
}

/**
 * Resolve o que o usuário pediu: `latest` (default), `best` (mais artigos), um NOME dentro do
 * BACKUP_DIR ou um CAMINHO qualquer. Retorna { file, articles } ou { error }.
 */
export function resolveBackupRef(ref, { dir = BACKUP_DIR } = {}) {
  const want = String(ref || 'latest');
  if (want === 'latest' || want === 'best') {
    const pick = want === 'latest' ? latestBackup(dir) : bestBackup(dir);
    if (!pick) return { error: `nenhum backup ${want === 'best' ? 'legível ' : ''}em ${dir}.` };
    return { file: pick.path, articles: pick.articles };
  }
  const candidates = [path.resolve(want), path.join(dir, want)];
  for (const c of candidates) {
    if (existsSync(c)) return { file: c, articles: countArticlesIn(c) };
  }
  return { error: `backup não encontrado: "${want}" (tentei ${candidates.join(' e ')}).` };
}

/**
 * A RECEITA da reposição a partir de um arquivo — e ela tem uma ordem obrigatória:
 *   1. FECHAR a conexão viva (o SQLite ainda pode ter páginas por gravar);
 *   2. APAGAR o `.db` E os sidecars `-wal`/`-shm`. Este é o passo que ninguém lembra: um `-wal`
 *      remanescente é reaplicado no próximo open POR CIMA do arquivo recém-copiado, e o usuário
 *      volta ao banco velho achando que restaurou;
 *   3. só então COPIAR o backup para o lugar.
 * `copyFileSync` (e não rename) para o backup continuar existindo depois da reposição.
 * Retorna { ok, error }. Nunca lança.
 */
export function swapDatabaseFile(source, { dbPath = DB_PATH, close = null } = {}) {
  const src = realPath(source);
  if (!existsSync(src)) return { ok: false, error: `arquivo de origem não existe: ${source}` };
  if (src === realPath(dbPath)) return { ok: false, error: 'origem e destino são o MESMO arquivo — nada a fazer.' };
  try {
    if (close) close();
    else db.close();
  } catch {
    /* já fechado: seguir é seguro (o objetivo era garantir que ninguém escreve mais) */
  }
  try {
    for (const f of [dbPath, ...SIDECARS.map((s) => dbPath + s)]) if (existsSync(f)) unlinkSync(f);
  } catch (e) {
    return { ok: false, error: `não consegui remover o banco atual (${e.message}) — nada foi copiado.` };
  }
  try {
    copyFileSync(src, dbPath);
  } catch (e) {
    return { ok: false, error: `cópia falhou (${e.message}) — o banco está AUSENTE; copie à mão: cp "${src}" "${dbPath}".` };
  }
  return { ok: true, error: null };
}

/**
 * `ncrawl backup` | `backup list` | `backup restore [<arquivo>|latest|best] --yes`
 * Sem subcomando, CRIA uma cópia (é o gesto mais comum e o mais seguro).
 */
export function cmdBackup(rest = [], flags = {}) {
  const sub = String(rest[0] || 'create').toLowerCase();

  if (sub === 'list' || sub === 'ls') {
    for (const line of backupListLines(listBackups(), BACKUP_DIR)) log(line);
    return { action: 'list' };
  }

  if (sub === 'create' || sub === 'new') {
    // Banco sem NENHUMA linha não é falha de backup — é "não havia o que copiar". Distinguir os
    // dois é o que impede um `ncrawl backup` numa base recém-criada de sair com exit 1 e assustar.
    if (!hasAnyData()) {
      log(`backup: o banco (${DB_PATH}) não tem dado nenhum — não havia o que copiar.`);
      return { action: 'create', backup: null };
    }
    const made = createBackup({ reason: typeof flags.reason === 'string' ? flags.reason : 'manual' });
    if (!made) {
      errorLog(`backup NÃO criado (veja o motivo acima). Banco: ${DB_PATH}; destino: ${BACKUP_DIR}.`);
      process.exit(1);
    }
    try {
      pruneBackups();
    } catch (e) {
      warn(`backup: retenção falhou (${e.message}) — a cópia nova está a salvo.`);
    }
    log(`para repor esta cópia depois:  ncrawl backup restore ${made.name} --yes`);
    return { action: 'create', backup: made };
  }

  if (sub === 'restore' || sub === 'load') {
    const picked = resolveBackupRef(rest[1], { dir: BACKUP_DIR });
    if (picked.error) {
      errorLog(`backup restore: ${picked.error}`);
      errorLog('Veja o que existe com:  ncrawl backup list');
      process.exit(1);
    }
    if (picked.articles === null) {
      errorLog(
        `backup restore: ${picked.file} não abre como banco SQLite (corrompido/truncado) — reposição ABORTADA. ` +
          'Escolha outra cópia (ncrawl backup list).',
      );
      process.exit(1);
    }
    const existing = liveArticles();
    if (flags.yes !== true) {
      errorLog(
        `backup restore SUBSTITUI ${DB_PATH} (${existing < 0 ? '?' : existing} artigo(s) agora) pela cópia ` +
          `${picked.file} (${picked.articles} artigo(s)). O banco atual vira backup antes.`,
      );
      errorLog(`Confirme com:  ncrawl backup restore ${rest[1] || 'latest'} --yes`);
      process.exit(1);
    }
    // O banco ATUAL vira backup antes de ser substituído: repor uma cópia velha não pode ser mais
    // uma forma de perder o que estava vivo.
    const guard = backupBeforeDestructive('pre-backup-restore');
    if (!guard.ok) {
      errorLog('backup restore ABORTADO: sem uma cópia do banco atual não se sobrescreve o banco. NADA foi tocado.');
      process.exit(1);
    }
    const swap = swapDatabaseFile(picked.file);
    if (!swap.ok) {
      errorLog(`backup restore: ${swap.error}`);
      process.exit(1);
    }
    log(`banco reposto de ${picked.file} → ${DB_PATH} (${picked.articles} artigo(s)).`);
    log('a conexão foi fechada nesta execução — rode `ncrawl status` para conferir a base nova.');
    return { action: 'restore', file: picked.file, articles: picked.articles, closed: true };
  }

  errorLog(`backup: subcomando desconhecido "${sub}" (use: backup | backup list | backup restore <arquivo|latest|best> --yes)`);
  process.exit(1);
  return null;
}
