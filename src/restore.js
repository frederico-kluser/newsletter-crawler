// RESTORE: o acervo volta do GIT, não do zero.
//
// A base de registro deste projeto deixou de ser o SQLite local e passou a ser o snapshot
// versionado em `webapp/public/data` (articles.json + contents*.json + meta.json), commitado a
// cada deploy/pre-push. Um `reset` acidental (que já aconteceu duas vezes, uma delas levando
// 3249 artigos e ~US$ 12 de LLM 1min45 depois da coleta) não pode mais significar "recomeçar do
// zero": o histórico do git guarda TODOS os snapshots, e a UNIÃO deles é maior que qualquer um
// isolado (medido neste repo: 15.5k artigos únicos contra 13.7k do snapshot mais novo).
//
// CINCO DECISÕES QUE ESTE MÓDULO FIXA (todas medidas, nenhuma improvisada):
//
// 1. IDENTIDADE = URL NORMALIZADA. Os ids do snapshot NÃO são estáveis ao longo do histórico:
//    cada wipe reiniciou o rowid em 1, e 4.228 ids apontam para mais de uma URL na história. Só
//    a URL (normalizeUrl, o mesmo dedup do crawler) identifica um artigo entre snapshots.
// 2. OS IDS DO SNAPSHOT MAIS NOVO SÃO AUTORITATIVOS. São os que o site no ar serve, os que a API
//    pública v1 promete como "identificador estável" e os que o histórico de buscas re-hidrata
//    (searches.hits_json / webapp history). Uma URL presente no snapshot mais novo é restaurada
//    COM O MESMO id; as que só existem em snapshots antigos recebem ids NOVOS, alocados ACIMA do
//    maior id do snapshot mais novo (zero colisão). Um id de snapshot antigo NUNCA é reusado:
//    ele colidiria com o id de outra URL no snapshot novo.
// 3. MERGE POR RIQUEZA, NÃO POR RECÊNCIA. Comparação real sobre a mesma união: "mais recente
//    vence" perde ~720 resumos e ~725 classificações contra "mais rico vence", porque snapshots
//    novos e POBRES (feitos logo depois de um wipe, antes do finish) sobrescreveriam snapshots
//    antigos e ricos. Riqueza = soma ponderada de summary_pt/title_pt/tags/verify_status/
//    date_iso (ver metaRichness). O CORPO é resolvido à parte (ver bodyPolicy) — assim um
//    registro nunca perde o corpo por ter perdido o desempate de metadados.
// 4. O CORPO VENCEDOR É O DE MAIOR SUBSTÂNCIA (bodyPolicy 'best', default). "O corpo do snapshot
//    mais novo" (a política anterior) DESCARTA conteúdo: medidos 916 artigos em que um snapshot
//    ANTIGO tem corpo maior, somando 1.224.751 caracteres, e a leitura dos 10 maiores mostrou o
//    corpo NOVO sendo o lixo na maioria (CHANGELOG do vite: 8 caracteres "Vite 8.2" contra
//    89.846 do changelog inteiro; awesome-mac: 518 de moldura do GitHub contra 85.396 do README;
//    safedep: 236 do blurb do agregador contra 58.402 do artigo; react-redux#2318: 6.079 de
//    "added 14 commits" contra 53.422 da descrição real). 'best' = maior SUBSTÂNCIA
//    (substanceLength: espaços em branco colapsados — sem isso, 351 casos "ganhavam" só linhas
//    em branco de uma extração antiga), com o candidato REJEITADO quando é HTML cru
//    (looksLikeRawHtml — o bug de "HTML na UI", content salvo com tags antes do guard
//    ensurePlainText); empate fica com o mais novo. 'first' (a antiga) e 'longest' (sem sanidade)
//    continuam disponíveis em CRAWLER_RESTORE_BODY_POLICY / bodyPolicy. Medido no acervo com a
//    política nova: 805 corpos MELHORAM (+1.192.365 caracteres), 0 pioram, e 247 candidatos
//    maiores são recusados por não trazerem substância nenhuma (só linhas em branco a mais).
//    Custo: 12 s em vez de 3,4 s, e +90 MB de pico — o preço de varrer todo o histórico.
//
// 5. A FRONTEIRA DO WIPE É ANCORADA NO CONTEÚDO, não no sha nem na data de commit. `git rm` não
//    apaga o histórico: sem uma fronteira, o restore ressuscita o que o `reset` acabou de apagar.
//    A fronteira era "sha do commit, com fallback pela data de COMMIT (%cI)" — e um `git rebase`
//    (que o próprio deploy recomenda) derruba as duas coisas de uma vez: reescreve o commit do
//    marcador (o `^sha` deixa de cobrir a linhagem, e num clone o sha nem existe) e carimba
//    "agora" no %cI de TODO o histórico, então nada mais é `<= at`. Agora a fronteira principal é
//    o `generatedAt` do snapshot descartado, que mora DENTRO do commit (imune a rebase, amend,
//    cherry-pick e filter-branch), com `%aI` (data de AUTORIA, que o rebase preserva) como rede
//    de segurança para marcadores v1. Ver wipeBoundary.
//
// DOIS FORMATOS DE CONTEÚDO coexistem no histórico e AMBOS são lidos:
//   - legado: `contents.json` = { "<id>": "<corpo>" } (até ce50d65, 30/08);
//   - atual : `contents.part0.json` + `contents.part1.json` … com `meta.contentsParts`
//     [{file, from, to}] (o arquivo único passou de 100 MB e o GitHub rejeita blobs > 100 MB).
//   Um restore escrito só contra `contents.json` acharia ZERO corpos nos 3 commits mais ricos.
//
// MEMÓRIA. contents.part0.json tem ~89 MB e há 30 commits de dados (~889 MB somados). Nada é
// carregado de uma vez: os corpos são varridos LINHA A LINHA direto do Buffer do `git show`
// (o export usa `JSON.stringify(map, null, 1)`, então cada par id→corpo cabe numa linha), a
// varredura decide pelo TAMANHO DA LINHA se vale materializar o corpo (shouldRead) e um snapshot
// inteiro é PULADO quando nenhuma das URLs dele ainda precisa de corpo. Ainda assim o acervo
// RETIDO é grande (pico medido: 660 MB de VmHWM com 'first', 753 MB com 'best'), e um
// `FATAL ERROR: Reached heap limit` do V8 é um ABORT do processo — o try/catch do
// maybeAutoRestore NÃO o captura. Daí a proteção em dois tempos (ver "orçamento de memória"):
// estimativa ANTES (por tamanho de blob, sem ler nada) e vigia do heap DURANTE, que PARA a fase
// e devolve o que já juntou. Medido com `--max-old-space-size=220`: o código anterior morria com
// FATAL; agora restaura os 15.526 metadados avisando que os corpos ficaram para depois.
//
// SÍNCRONO DE PROPÓSITO. Os chamadores (printStatus, o boot da TUI, cmdReset) são síncronos, e
// better-sqlite3/execFileSync também — uma promise flutuante aqui viraria bug de corrida.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';

import { AUTO_RESTORE, RESTORE_BODY_POLICY, ROOT, loadSources } from './config.js';
import {
  countArticles,
  markUrlDone,
  restoreArticle,
  restoreCounts,
  restorePage,
  restoreSourceByName,
  restoreTags,
  db,
  stmts,
} from './db.js';
import { log, normalizeUrl, warn } from './util.js';

// ---- caminhos do snapshot (relativos à raiz do repo; o `reset` remove o diretório inteiro) ----
export const DATA_DIR_REL = 'webapp/public/data';
export const ARTICLES_REL = `${DATA_DIR_REL}/articles.json`;
export const META_REL = `${DATA_DIR_REL}/meta.json`;
export const CONTENTS_LEGACY = 'contents.json';
// Quantas partes sondar quando o meta.json do commit não existe/não traz contentsParts.
const MAX_PART_PROBE = 32;
// `git show` de um blob de ~104 MB não cabe no maxBuffer default (1 MB).
const GIT_MAX_BUFFER = 1024 * 1024 * 1024;

// ---- marcador de wipe (lado LEITOR; o escritor é fiado no cmdReset — ver writeWipeMarker) ----
// `git rm` (o que o reset faz com webapp/public/data) NÃO apaga o HISTÓRICO: sem um marcador, um
// restore que lê o histórico RESSUSCITARIA exatamente o que o usuário acabou de apagar e o
// `reset` nunca funcionaria. O marcador é um arquivo VERSIONADO na RAIZ do repo — fora de
// webapp/public/data e de webapp/public/api/v1, os dois diretórios que o reset remove — que
// registra "tudo até este commit foi descartado de propósito".
export const WIPE_MARKER_FILE = '.nc-wipe.json';
// v2: cada entrada ganhou `authorAt` e `snapshotAt` — as duas âncoras que SOBREVIVEM a uma
// reescrita de histórico (ver wipeBoundary). Marcador v1 (só `commit`+`at`) continua sendo lido.
export const WIPE_MARKER_VERSION = 2;

// ---- git (tudo síncrono, tudo fail-open: sem git o restore avisa e segue) ----

function gitRaw(root, args, opts = {}) {
  return execFileSync('git', args, {
    cwd: root,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    ...opts,
  });
}

/** `git ...` devolvendo texto aparado, ou null em qualquer falha (repo ausente, path inexistente). */
function gitText(root, args) {
  try {
    return String(gitRaw(root, args, { encoding: 'utf8' })).trim();
  } catch {
    return null;
  }
}

/** `git show <rev>:<path>` devolvendo o Buffer CRU (não vira string: são ~100 MB por blob). */
function gitBlob(root, rev, rel) {
  try {
    return gitRaw(root, ['show', `${rev}:${rel}`]);
  } catch {
    return null;
  }
}

/** `.git` pode ser DIRETÓRIO (clone) ou ARQUIVO (git worktree) — daí o rev-parse de fallback. */
export function isGitRepo(root = ROOT) {
  if (existsSync(path.join(root, '.git'))) return true;
  return gitText(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

/** `git clone --depth 1` (default de muito CI) não tem histórico — só o working tree. */
export function isShallowRepo(root = ROOT) {
  return gitText(root, ['rev-parse', '--is-shallow-repository']) === 'true';
}

function revExists(root, rev) {
  return Boolean(gitText(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]));
}

// ---- marcador de wipe: leitura ----

// Aceita as duas formas (defensivo, fail-open): { version, wipes: [entrada, …] } e a entrada
// SOLTA { version, at, commit, … }. Uma entrada é { at (ISO), commit (sha), authorAt (%aI do
// commit), snapshotAt (meta.generatedAt do snapshot descartado), reason, articles }.
function normalizeMarker(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  const list = Array.isArray(parsed.wipes) ? parsed.wipes : Array.isArray(parsed) ? parsed : [parsed];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const at = typeof e.at === 'string' ? e.at : null;
    const commit = typeof e.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(e.commit) ? e.commit : null;
    if (!at && !commit) continue;
    out.push({
      at,
      commit,
      authorAt: typeof e.authorAt === 'string' ? e.authorAt : null,
      snapshotAt: typeof e.snapshotAt === 'string' ? e.snapshotAt : null,
      reason: typeof e.reason === 'string' ? e.reason : null,
      articles: Number.isFinite(e.articles) ? e.articles : null,
    });
  }
  return out;
}

function parseMarkerText(txt) {
  try {
    return normalizeMarker(JSON.parse(txt));
  } catch {
    return [];
  }
}

/**
 * Lê o marcador de wipe do working tree E do HEAD, e devolve a UNIÃO das entradas (dedup por
 * commit+at). Ler os dois é a direção CONSERVADORA: se alguém apagou o arquivo localmente mas
 * ele está commitado, a fronteira continua valendo — o erro caro aqui é ressuscitar dado que o
 * usuário apagou de propósito, não deixar de restaurar.
 * Retorna null quando não há marcador nenhum; senão { entries, commits, at } — `at` é a MAIOR
 * data registrada (usada só como fallback quando o commit da fronteira não existe no clone).
 */
export function readWipeMarker(root = ROOT) {
  const seen = new Set();
  const entries = [];
  const push = (list) => {
    for (const e of list) {
      const key = `${e.commit || ''}|${e.at || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(e);
    }
  };
  const file = path.join(root, WIPE_MARKER_FILE);
  if (existsSync(file)) {
    try {
      push(parseMarkerText(readFileSync(file, 'utf8')));
    } catch {
      /* fail-open: marcador ilegível não derruba o restore (mas também não vira fronteira) */
    }
  }
  const head = gitBlob(root, 'HEAD', WIPE_MARKER_FILE);
  if (head) push(parseMarkerText(head.toString('utf8')));
  if (!entries.length) return null;
  const commits = entries.map((e) => e.commit).filter(Boolean);
  const at = entries.map((e) => e.at).filter(Boolean).sort().at(-1) || null;
  return { entries, commits, at };
}

/**
 * ESCRITOR do marcador (a FIAÇÃO no `cmdReset` é de outra onda — esta função só escreve o
 * arquivo). Acrescenta uma entrada ao marcador existente (o histórico de wipes é preservado:
 * cada entrada é uma fronteira, e todas valem) e grava `<root>/.nc-wipe.json`.
 * NÃO faz `git add` nem commit: quem chama decide (no reset, o commit sai junto do `git rm` do
 * snapshot). Fail-open: devolve null e avisa se não conseguir escrever.
 */
export function writeWipeMarker({ root = ROOT, reason = 'reset', articles = null, commit, at, snapshotAt } = {}) {
  const sha = commit || gitText(root, ['rev-parse', 'HEAD']) || null;
  const entry = {
    at: at || new Date().toISOString(),
    commit: sha,
    // DUAS âncoras que sobrevivem a uma reescrita de histórico (ver wipeBoundary): a data de
    // AUTORIA do commit da fronteira (um rebase preserva %aI e reescreve %cI) e o `generatedAt`
    // do snapshot descartado, que mora DENTRO do commit — imune a sha e a data.
    authorAt: sha ? gitText(root, ['log', '-1', '--format=%aI', sha]) || null : null,
    snapshotAt: snapshotAt || (sha ? snapshotGeneratedAt(root, sha) : null) || null,
    reason,
    articles: Number.isFinite(articles) ? articles : null,
  };
  const file = path.join(root, WIPE_MARKER_FILE);
  let entries = [];
  if (existsSync(file)) {
    try {
      entries = parseMarkerText(readFileSync(file, 'utf8'));
    } catch {
      entries = [];
    }
  }
  entries.push(entry);
  try {
    writeFileSync(file, `${JSON.stringify({ version: WIPE_MARKER_VERSION, wipes: entries }, null, 1)}\n`);
  } catch (e) {
    warn(`marcador de wipe não pôde ser gravado (${e.message}) — o restore ainda enxerga o histórico.`);
    return null;
  }
  return { file, entry, entries };
}

// ---- listagem dos snapshots (working tree + commits de dados), do MAIS NOVO para o mais antigo ----

// `generatedAt` do snapshot commitado em <rev> (o meta.json tem ~60 KB — barato). Cacheado por
// sha: o conteúdo de um commit é imutável.
const GENERATED_AT_CACHE = new Map();
function snapshotGeneratedAt(root, rev) {
  const key = `${root}::${rev}`;
  if (GENERATED_AT_CACHE.has(key)) return GENERATED_AT_CACHE.get(key);
  const meta = readJsonBuffer(gitBlob(root, rev, META_REL), `meta.json de ${String(rev).slice(0, 8)}`);
  const gen = typeof meta?.generatedAt === 'string' ? meta.generatedAt : null;
  GENERATED_AT_CACHE.set(key, gen);
  return gen;
}

/**
 * A FRONTEIRA do wipe, resolvida em algo que SOBREVIVA A REESCRITA DE HISTÓRICO.
 *
 * O bug que isto conserta: a fronteira era `sha do commit` com fallback por `%cI` (data de
 * COMMIT). Um `git rebase` (que o próprio `deploy` recomenda em "remoto à frente: pull
 * --rebase") reescreve o commit do marcador — o sha registrado DEIXA DE EXISTIR no clone e o
 * código cai justamente no fallback por data; só que o rebase também reescreve o `%cI` de TODOS
 * os commits para "agora", nenhum deles é mais `<= at` e o restore RESSUSCITA o acervo que o
 * usuário apagou de propósito. Repro no test/restore.test.js ("rebase … NÃO ressuscita").
 *
 * As duas âncoras que ficam de pé:
 *   - `snapshotAt` (CONTEÚDO): o `generatedAt` do snapshot que estava commitado na fronteira.
 *     Mora DENTRO do commit, então rebase/amend/cherry-pick/filter-branch não o tocam. É a
 *     fronteira principal e vale SEMPRE (inclusive quando o sha ainda existe): um commit de
 *     dados cujo snapshot foi GERADO antes do wipe é, por definição, dado descartado — em
 *     qualquer branch, ancestral ou não.
 *   - `authorAt`/`at` (DATA DE AUTORIA): rede de segurança só para quando o sha sumiu E não há
 *     `snapshotAt` (marcador v1). `%aI` sobrevive ao rebase; `%cI` não — por isso o `git log`
 *     abaixo formata `%aI`.
 * O `^sha` continua como atalho exato enquanto o commit existir.
 *
 * CASO NÃO-ANCESTRAL (marcador num branch divergente): a fronteira de conteúdo NÃO olha
 * ancestralidade — ela derruba qualquer commit cujo snapshot foi gerado antes do wipe, em
 * QUALQUER branch. Um branch paralelo com snapshot antigo perde acervo que talvez não estivesse
 * incluído no wipe. É o lado SEGURO do erro e é aceito de propósito: perder acervo custa uma
 * coleta (e `marker: false` recupera tudo numa auditoria manual), enquanto ressuscitar o que o
 * usuário apagou de propósito quebra o `reset` — o motivo de este marcador existir.
 */
function wipeBoundary(root, marker) {
  let contentAt = null; // fronteira por CONTEÚDO (meta.generatedAt)
  let dateAt = null; // fronteira por DATA DE AUTORIA (só quando o sha sumiu e não há conteúdo)
  let alive = 0;
  for (const e of marker?.entries || []) {
    const here = Boolean(e.commit && revExists(root, e.commit));
    if (here) alive += 1;
    const snap = e.snapshotAt || (here ? snapshotGeneratedAt(root, e.commit) : null);
    if (snap && (!contentAt || snap > contentAt)) contentAt = snap;
    // Com o commit VIVO o `^sha` já corta a linhagem inteira; usar a data do marcador aqui
    // derrubaria commits legítimos posteriores feitos no mesmo instante (fixtures de teste).
    if (here || snap) continue;
    const when = e.authorAt || e.at || null;
    if (when && (!dateAt || when > dateAt)) dateAt = when;
  }
  return { contentAt, dateAt, alive };
}

/**
 * Commits que TOCARAM `webapp/public/data/articles.json`, do mais novo para o mais antigo,
 * já APLICANDO a fronteira do marcador de wipe (ver wipeBoundary):
 *   - `git log <ref> ^<wipe> -- <path>` exclui a linhagem do commit do wipe quando ele existe;
 *   - o `generatedAt` do snapshot de CADA commit é comparado com a fronteira de conteúdo;
 *   - a data de AUTORIA (`%aI`, nunca `%cI`) fecha o caso do marcador v1 com sha reescrito.
 * Retorna [{ commit, date }] (date = data de AUTORIA).
 */
export function listDataCommits({ root = ROOT, ref = '--all', marker = null, boundary = null } = {}) {
  const excludes = [];
  for (const c of marker?.commits || []) if (revExists(root, c)) excludes.push(`^${c}`);
  const bound = boundary || (marker ? wipeBoundary(root, marker) : null);
  const out = gitText(root, ['log', '--format=%H %aI', ref, ...excludes, '--', ARTICLES_REL]);
  if (out == null) return [];
  const rows = [];
  let undated = 0;
  for (const line of out.split('\n')) {
    const [commit, date] = line.trim().split(' ');
    if (!commit || !/^[0-9a-f]{7,40}$/i.test(commit)) continue;
    if (bound?.contentAt) {
      const gen = snapshotGeneratedAt(root, commit);
      // Sem `generatedAt` legível não dá para situar o commit em relação ao wipe: com fronteira
      // em vigor, o descarte é FAIL-CLOSED (o erro caro é ressuscitar dado apagado de propósito;
      // perder um snapshot exótico só custa uma coleta).
      if (gen == null) {
        undated += 1;
        continue;
      }
      if (gen <= bound.contentAt) continue;
    }
    if (bound?.dateAt && date && date <= bound.dateAt) continue;
    rows.push({ commit, date: date || null });
  }
  if (undated) {
    warn(
      `restore: ${undated} commit(s) de dados sem meta.generatedAt legível foram DESCARTADOS ` +
        '(há marcador de wipe em vigor — a fronteira é fail-closed).',
    );
  }
  return rows;
}

// ---- leitura de um snapshot (do working tree ou de um commit) ----

function readJsonBuffer(buf, what) {
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    warn(`restore: ${what} ilegível (${e.message}) — snapshot ignorado.`);
    return null;
  }
}

function readWorktreeFile(root, rel) {
  const file = path.join(root, rel);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

// Um snapshot é lido pelo MESMO código venha do disco ou do git — só muda o "leitor de blob".
function snapshotReader(root, snap) {
  return snap.kind === 'worktree'
    ? (rel) => readWorktreeFile(root, rel)
    : (rel) => gitBlob(root, snap.commit, rel);
}

/**
 * Arquivos de conteúdo do snapshot, JÁ LIDOS ({file, format, buf}): `meta.contentsParts` quando
 * existe (formato atual), senão SONDA os dois formatos — contents.json (legado) e
 * contents.partN.json (meta.json ausente ou antigo demais). A sondagem devolve o buffer que leu
 * em vez de só um nome: um `git show` de 89 MB só para testar existência custaria o dobro.
 */
function contentsFiles(meta, read) {
  const parts = Array.isArray(meta?.contentsParts) ? meta.contentsParts : [];
  const named = parts.map((p) => p?.file).filter((f) => typeof f === 'string' && f);
  const out = [];
  // Com os nomes vindos do meta não há o que sondar: `buf: null` deixa a leitura para o laço, que
  // solta cada parte antes de abrir a próxima (senão part0+part1 ficariam juntas na memória).
  if (named.length) return named.map((file) => ({ file, format: 'parts', buf: null }));
  const legacy = read(`${DATA_DIR_REL}/${CONTENTS_LEGACY}`);
  if (legacy) out.push({ file: CONTENTS_LEGACY, format: 'legacy', buf: legacy });
  for (let i = 0; i < MAX_PART_PROBE; i += 1) {
    const file = `contents.part${i}.json`;
    const buf = read(`${DATA_DIR_REL}/${file}`);
    if (!buf) break;
    out.push({ file, format: 'parts', buf });
  }
  return out;
}

/**
 * Varre um Buffer de contents SEM `JSON.parse` do arquivo inteiro. O export escreve
 * `JSON.stringify(map, null, 1)`, então cada par vira UMA linha ` "123": "corpo",` (JSON escapa
 * \n dentro das strings, logo nenhum corpo quebra linha) — dá para decidir por id ANTES de
 * materializar o corpo, e um blob de 89 MB nunca vira um objeto de 89 MB.
 * Fail-open: se NENHUMA linha do buffer não-trivial estiver no formato esperado, cai no
 * JSON.parse completo (formato diferente é possível num snapshot antigo) — note que o gatilho é
 * "nenhuma linha reconhecida", não "nenhum corpo entregue": com `shouldRead` filtrando tudo, o
 * arquivo NÃO pode ser re-lido inteiro.
 * `onEntry(id, body)` é chamado por par materializado; `shouldRead(id, maxLen)` (opcional) decide
 * ANTES de materializar — `maxLen` é o tamanho da LINHA, um teto para o tamanho do corpo (o
 * escape do JSON só aumenta), e é o que deixa a política 'best'/'longest' varrer todo o histórico
 * sem pagar o JSON.parse de corpos que já perderam. Devolve o total de pares ENTREGUES.
 */
export function scanContentsBuffer(buf, onEntry, { shouldRead = null } = {}) {
  if (!buf || !buf.length) return 0;
  let seen = 0;
  let matched = 0;
  let start = 0;
  const len = buf.length;
  while (start < len) {
    let nl = buf.indexOf(0x0a, start);
    if (nl === -1) nl = len;
    if (nl - start > 5) {
      // Só o COMEÇO da linha vira string aqui: a chave cabe nos primeiros bytes, e materializar a
      // linha inteira (7 KB em média, 400 mil linhas no histórico) só para ler o id seria o
      // mesmo desperdício que parsear o arquivo todo.
      const headEnd = Math.min(start + 32, nl);
      const head = buf.toString('utf8', start, headEnd).trimStart();
      if (head.charCodeAt(0) === 34 /* " */) {
        const q = head.indexOf('": ');
        const key = q > 1 ? head.slice(1, q) : '';
        if (key && /^\d+$/.test(key)) {
          matched += 1;
          const id = Number(key);
          if (!shouldRead || shouldRead(id, nl - start)) {
            const line = buf.toString('utf8', start, nl);
            const t = line.trimStart();
            let rest = t.slice(t.indexOf('": ') + 3).trimEnd();
            if (rest.endsWith(',')) rest = rest.slice(0, -1);
            if (rest.charCodeAt(0) === 34) {
              // O try cobre SÓ o parse: um erro vindo do `onEntry` (a parada por memória, por
              // exemplo) tem de subir, não ser confundido com "linha fora do formato".
              let body = null;
              try {
                const parsed = JSON.parse(rest);
                if (typeof parsed === 'string') body = parsed;
              } catch {
                /* linha fora do formato: ignorada (o fallback abaixo cobre o arquivo todo) */
              }
              if (body !== null) {
                seen += 1;
                onEntry(id, body);
              }
            }
          }
        }
      }
    }
    start = nl + 1;
  }
  if (matched === 0 && len > 16) {
    const obj = readJsonBuffer(buf, 'contents');
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v !== 'string') continue;
        const id = Number(k);
        if (!Number.isFinite(id)) continue;
        if (shouldRead && !shouldRead(id, v.length)) continue;
        seen += 1;
        onEntry(id, v);
      }
    }
  }
  return seen;
}

// ---- orçamento de MEMÓRIA (um bootstrap automático não pode morrer com FATAL do V8) ----
//
// `FATAL ERROR: … Reached heap limit — Allocation failed` NÃO é exceção: é um abort do V8, e o
// `try/catch` do maybeAutoRestore (fail-open "em tudo") não o captura. Medido no acervo real:
// 668 MB de pico; com `--max-old-space-size=220` o processo morre (o banco fica íntegro — o WAL
// faz rollback —, mas o comando que chamou o restore morre junto). Como o restore roda em
// BOOTSTRAP AUTOMÁTICO, a proteção é proporcional e em dois tempos:
//   1. ANTES: estimativa por TAMANHO DE BLOB (`git cat-file -s`, não lê conteúdo nenhum). Se os
//      corpos não couberem no heap disponível, a fase de corpos nem começa — o restore repõe os
//      METADADOS (resumos, tags, classificações, frontier: o que custou LLM) e diz como voltar
//      com mais heap. O corpo o crawler re-enriquece; o resumo custa dinheiro.
//   2. DURANTE: vigia do heap entre snapshots e a cada 256 corpos. Ao passar do teto, a fase
//      PARA e o restore devolve o que já juntou (degradação), em vez de estourar.
export const MEM_STOP_FRAC = 0.82; // heap usado acima disto => a fase corrente para
export const MEM_PLAN_FRAC = 0.7; // a estimativa dos corpos precisa caber nisto do heap livre
// Bytes de JSON -> bytes de heap retido. Calibrado no acervo real (109 MB de contents, 15.5k
// artigos): a união guarda o corpo vencedor de cada URL (o histórico acrescenta ~13% sobre o
// snapshot mais novo) e uma string V8 de 1 byte/char ainda paga cabeçalho por objeto.
const BODY_HEAP_FACTOR = 1.35;
// O JSON.parse de um articles.json de 25 MB precisa do buffer + do objeto + da folga do GC.
const META_HEAP_FACTOR = 3;

/** Sentinela de PARADA por memória — capturada dentro do collect, nunca escapa para o chamador. */
class MemoryStop extends Error {
  constructor(phase) {
    super(`memória apertada na fase ${phase}`);
    this.phase = phase;
  }
}

// O TETO REAL para dado de vida longa NÃO é o `heap_size_limit` do V8. Medido: com
// `--max-old-space-size=220` o V8 REPORTA 432 MB de limite (ele soma old space + young
// generation + code space) e o processo morre com 222 MB usados — um orçamento baseado no
// número reportado acha que há folga e deixa o FATAL acontecer (foi o que aconteceu na 1ª
// tentativa deste fix). Tudo que o restore retém é de vida longa (old space), então:
//   - com `--max-old-space-size=N` explícito (execArgv ou NODE_OPTIONS), o orçamento é N;
//   - sem ele, METADE do heap_size_limit — conservador, e ainda folgadíssimo no default (4 GB
//     reportados => 2 GB de orçamento para um acervo que precisa de ~150 MB).
const MAX_OLD_SPACE_RE = /^--max[-_]old[-_]space[-_]size=(\d+)$/;
const lastFlag = (args) => {
  const hit = args.map((a) => MAX_OLD_SPACE_RE.exec(String(a).trim())).filter(Boolean).at(-1);
  return hit ? Number(hit[1]) * 1048576 : 0;
};
function oldSpaceLimitBytes() {
  try {
    const reported = v8.getHeapStatistics().heap_size_limit || 0;
    // A LINHA DE COMANDO vence o NODE_OPTIONS (é a precedência do próprio node) — e o resultado
    // nunca passa do que o V8 reporta.
    const flag = lastFlag(process.execArgv) || lastFlag(String(process.env.NODE_OPTIONS || '').split(/\s+/));
    if (flag) return reported ? Math.min(flag, reported) : flag;
    return Math.round(reported * 0.5);
  } catch {
    return 0; // fail-open: sem orçamento, só o vigia por uso decide
  }
}

/**
 * Heap do V8 agora: { limitBytes, usedBytes, freeBytes }. `limitOverride` (> 0) troca o teto por
 * um explícito — é o que permite exercitar a degradação sem subir um processo com
 * `--max-old-space-size`, e serve a quem quiser um teto MENOR que o do V8.
 */
export function heapStats(limitOverride = 0) {
  const limitBytes = limitOverride > 0 ? limitOverride : oldSpaceLimitBytes();
  const usedBytes = process.memoryUsage().heapUsed;
  return { limitBytes, usedBytes, freeBytes: limitBytes ? Math.max(0, limitBytes - usedBytes) : Infinity };
}

const mb = (bytes) => Math.round(bytes / 1048576);

/** Tamanho de um blob SEM lê-lo (`git cat-file -s`) ou do arquivo no working tree. */
function blobSize(root, snap, rel) {
  if (snap.kind === 'worktree') {
    try {
      return statSync(path.join(root, rel)).size;
    } catch {
      return 0;
    }
  }
  const out = gitText(root, ['cat-file', '-s', `${snap.commit}:${rel}`]);
  const n = out ? Number(out) : NaN;
  return Number.isFinite(n) ? n : 0;
}

// ---- riqueza (merge por REGISTRO MAIS RICO, não pelo mais recente) ----

// Pesos: o resumo PT-BR é o que mais custou LLM, as tags vêm logo atrás (as duas coisas que a
// comparação real mostrou serem PERDIDAS por uma política "mais recente vence"). `snippet` entra
// com peso 1 só como desempate fraco; o CORPO não entra aqui de propósito — ele é resolvido
// independentemente (bodyPolicy), o que domina qualquer peso: um registro nunca perde o corpo por
// ter perdido o desempate de metadados.
function hasTags(tags) {
  if (!tags || typeof tags !== 'object') return false;
  for (const v of Object.values(tags)) if (Array.isArray(v) && v.length) return true;
  return false;
}

// ---- corpo: QUAL snapshot vence (bodyPolicy) ----
//
// A política default é 'best' = MAIOR SUBSTÂNCIA, com sanidade. Ela existe porque 'first' (o
// corpo do snapshot mais novo que tenha um) DESCARTA conteúdo medido: 916 artigos têm corpo
// maior num snapshot ANTIGO, somando 1.224.751 caracteres, e na leitura dos 10 maiores o corpo
// NOVO era o lixo na maioria (o título sozinho, a moldura do GitHub, o blurb do agregador, a
// timeline "added 14 commits"). Duas correções sobre o "maior vence" cru:
//   - SUBSTÂNCIA, não bytes: 351 dos 916 casos só ganhavam linhas em branco de uma extração
//     antiga; com os espaços colapsados eles empatam e o desempate fica com o mais novo (limpo).
//   - SANIDADE: candidato que é HTML CRU perde para qualquer texto (o bug de "HTML na UI" —
//     content salvo com tags, de antes do guard ensurePlainText no armazenamento).
export const BODY_POLICIES = new Set(['best', 'first', 'longest']);

// O looksLikeHtml do parse-core dispara com UMA `</tag>` — é a regra certa para um blurb de uma
// linha, e a errada aqui: a pergunta é sobre um DOCUMENTO INTEIRO e um falso-positivo JOGA
// CONTEÚDO FORA. Neste acervo (técnico) a prosa vem cheia de EXEMPLO DE CÓDIGO HTML/JSX: medido,
// "densidade de tags" sozinha marcou 52 artigos legítimos como HTML cru (o post do Remix 3 tem
// 232 tags em 65 KB de texto; component-party.dev, 218 — e o corpo alternativo tinha 79 e 320
// caracteres). Por isso são TRÊS condições JUNTAS:
//   1. o corpo COMEÇA em marcação (um dump de HTML abre com <div/<html/<section; um artigo com
//      exemplo de código começa em prosa);
//   2. pelo menos 8 tags;
//   3. pelo menos 15% dos caracteres SÃO marcação (num artigo com exemplos, ~5%).
const RAW_HTML_TAG_RE =
  /<\/?(?:a|article|body|br|button|div|footer|form|h[1-6]|head|header|html|iframe|img|input|li|main|nav|ol|option|p|script|section|select|span|style|svg|table|tbody|td|th|thead|tr|ul)\b[^>]*>/gi;
const RAW_HTML_START_RE =
  /^\s*(?:<!doctype|<\/?(?:html|head|body|div|section|article|main|nav|header|footer|span|table|ul|ol|li|p|h[1-6])[\s>/]|<(?:a|img|iframe|script|style)\s)/i;
const RAW_HTML_MIN_TAGS = 8;
const RAW_HTML_MARKUP_FRAC = 0.15;

/** O corpo é HTML CRU (marcação, não artigo)? Puro/testável. */
export function looksLikeRawHtml(body) {
  const str = typeof body === 'string' ? body : '';
  if (str.length < 32) return false;
  if (!RAW_HTML_START_RE.test(str)) return false;
  const tags = str.match(RAW_HTML_TAG_RE);
  if (!tags || tags.length < RAW_HTML_MIN_TAGS) return false;
  let markup = 0;
  for (const t of tags) markup += t.length;
  return markup >= str.length * RAW_HTML_MARKUP_FRAC;
}

/** Tamanho em SUBSTÂNCIA: espaços em branco em sequência valem por um. Puro/testável. */
export function substanceLength(body) {
  const str = typeof body === 'string' ? body : '';
  if (!str) return 0;
  let n = 0;
  let ws = false;
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    const isWs = c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 0xa0;
    if (isWs) {
      if (!ws) n += 1;
      ws = true;
    } else {
      n += 1;
      ws = false;
    }
  }
  return n;
}

/**
 * Nota do candidato a corpo, pela política. A regra de substituição é sempre `nota > nota atual`
 * (estrita), e a varredura é do mais novo para o mais antigo — então EMPATE FICA COM O MAIS NOVO.
 * 'first' dá nota a um único candidato (o primeiro que aparece) e -1 a todos os outros.
 */
function bodyScorer(policy) {
  if (policy === 'first') return (body, rec) => (rec.contentScore < 0 ? 1 : -1);
  if (policy === 'longest') return (body) => body.length;
  return (body) => (looksLikeRawHtml(body) ? 0 : substanceLength(body)); // 'best'
}

export function metaRichness(row) {
  let s = 0;
  if (row?.summary_pt) s += 4;
  if (hasTags(row?.tags)) s += 3;
  if (row?.title_pt) s += 2;
  if (row?.verify_status) s += 1;
  if (row?.date_iso) s += 1;
  if (row?.snippet) s += 1;
  return s;
}

// ---- coleta: a UNIÃO de todos os snapshots, por URL ----

/**
 * Lê os snapshots (working tree + histórico do git), monta a UNIÃO por URL normalizada com merge
 * por riqueza, resolve o corpo nos DOIS formatos de contents e devolve { records, report }.
 *
 * Opções:
 *   - `ref`        : escopo do histórico (default `--all`: qualquer branch/tag alcança o dado).
 *   - `root`       : raiz do repo (default ROOT, a raiz do pacote).
 *   - `worktree`   : inclui o snapshot do working tree (default true). NÃO é "working tree
 *                    primeiro": ele é só o snapshot MAIS NOVO — o histórico costuma ser MAIOR
 *                    (medido: 13.758 no working tree contra 15.526 na união).
 *   - `bodies`     : false pula a fase de corpos (coleta só metadados; muito mais rápida).
 *   - `bodyPolicy` : 'best' (DEFAULT, ver a seção de bodyPolicy) = maior SUBSTÂNCIA entre os
 *                    snapshots, rejeitando candidato que é HTML cru, empate com o mais novo;
 *                    'first' = o corpo não-vazio do snapshot mais novo que tiver um (a política
 *                    antiga: mais rápida, mas deixa 916 corpos maiores para trás);
 *                    'longest' = o MAIOR corpo em bytes, sem sanidade nenhuma (auditoria).
 *                    Default global em CRAWLER_RESTORE_BODY_POLICY (config.js).
 *   - `marker`     : marcador de wipe já lido (default: lê do repo). `false` desliga a fronteira.
 *   - `heapLimitBytes`: teto de heap EXPLÍCITO (default: o do V8). Serve a quem quer um teto
 *                    menor que o do processo e é como a degradação por memória é exercitada.
 *
 * Cada registro: { url, id, title, title_pt, summary_pt, snippet, date_iso, kind, section,
 *                  issue_url, verify_status, verify_notes, tags, content, source_name,
 *                  from, contentFrom }.
 * `id` = id do snapshot MAIS NOVO quando a URL aparece nele; null quando a URL só existe em
 * snapshots antigos (o chamador aloca um id novo — ver restoreFromGit).
 */
export function collectFromGit({
  ref = '--all',
  root = ROOT,
  worktree = true,
  bodies = true,
  bodyPolicy = RESTORE_BODY_POLICY,
  marker,
  heapLimitBytes = 0,
} = {}) {
  const started = Date.now();
  const policy = BODY_POLICIES.has(bodyPolicy) ? bodyPolicy : 'best';
  if (policy !== bodyPolicy) warn(`restore: bodyPolicy "${bodyPolicy}" desconhecida — usando "best".`);
  let peakRss = process.memoryUsage().rss;
  let peakHeap = process.memoryUsage().heapUsed;
  const notePeak = () => {
    const m = process.memoryUsage();
    if (m.rss > peakRss) peakRss = m.rss;
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
  };
  const heap = () => heapStats(heapLimitBytes);
  const heapTight = () => {
    const h = heap();
    return h.limitBytes > 0 && h.usedBytes > h.limitBytes * MEM_STOP_FRAC;
  };

  const repo = isGitRepo(root);
  const shallow = repo ? isShallowRepo(root) : false;
  const wipe = marker === undefined ? readWipeMarker(root) : marker || null;
  const bound = wipe ? wipeBoundary(root, wipe) : null;

  // ---- 1. quais snapshots, do mais novo para o mais antigo ----
  const snapshots = [];
  if (worktree && existsSync(path.join(root, ARTICLES_REL))) {
    snapshots.push({ kind: 'worktree', commit: null, date: null, label: 'working tree' });
  }
  let commits = [];
  if (repo) {
    if (shallow) {
      warn(
        'restore: clone RASO (--depth 1) — o histórico do snapshot não veio junto; só o working ' +
          'tree será lido. Um `git fetch --unshallow` recupera os snapshots antigos.',
      );
    } else {
      commits = listDataCommits({ root, ref, marker: wipe, boundary: bound });
      for (const c of commits) {
        snapshots.push({ kind: 'commit', commit: c.commit, date: c.date, label: c.commit.slice(0, 8) });
      }
    }
  } else {
    warn(`restore: ${root} não é um repositório git — sem histórico para restaurar.`);
  }

  // O working tree também está sujeito à fronteira: um snapshot gerado ANTES do wipe (o `reset`
  // remove o diretório, mas um clone pode trazê-lo de volta) não pode ressuscitar o acervo. A
  // fronteira aqui é a MAIOR entre a hora do wipe e o generatedAt da fronteira de conteúdo.
  const worktreeCut = [wipe?.at, bound?.contentAt].filter(Boolean).sort().at(-1) || null;
  if (worktreeCut && snapshots[0]?.kind === 'worktree') {
    const meta = readJsonBuffer(readWorktreeFile(root, META_REL), 'meta.json do working tree');
    const gen = typeof meta?.generatedAt === 'string' ? meta.generatedAt : null;
    if (gen && gen <= worktreeCut) {
      snapshots.shift();
      log(`restore: working tree (${gen}) é anterior ao wipe (${worktreeCut}) — ignorado.`);
    }
  }

  const report = {
    root,
    ref,
    repo,
    shallow,
    wipe: wipe ? { entries: wipe.entries.length, at: wipe.at, commits: wipe.commits } : null,
    commits: commits.length,
    snapshots: [],
    articles: 0,
    withBody: 0,
    withSummary: 0,
    withTags: 0,
    withTitlePt: 0,
    withDate: 0,
    withIssueUrl: 0,
    fromNewest: 0,
    bodiesFromParts: 0,
    bodiesFromLegacy: 0,
    bodyPolicy: policy,
    bodiesRejectedHtml: 0,
    // memória: o que o orçamento decidiu e o que o vigia interrompeu (null = correu inteiro)
    memory: { heapLimitMb: mb(heap().limitBytes), needMb: 0, skippedBodies: false, stoppedAt: null },
    peakRssMb: 0,
    peakHeapMb: 0,
    ms: 0,
  };
  const finish = (records) => {
    notePeak();
    report.peakRssMb = mb(peakRss);
    report.peakHeapMb = mb(peakHeap);
    report.ms = Date.now() - started;
    return { records, report };
  };
  if (!snapshots.length) return finish([]);

  // ---- 2. passada de METADADOS (articles.json de cada snapshot; nenhum corpo é lido aqui) ----
  const union = new Map(); // url normalizada -> registro vencedor
  const idIndex = []; // por snapshot: Map(id do snapshot -> url) — a ponte para os contents
  const metaBySnap = []; // por snapshot: o meta.json (contentsParts + nomes das fontes)

  for (let i = 0; i < snapshots.length; i += 1) {
    const snap = snapshots[i];
    const read = snapshotReader(root, snap);
    // VIGIA (metadados): o JSON.parse de um articles.json de 25 MB precisa de ~3x o tamanho em
    // heap. Sem folga, a varredura PARA aqui — a união já tem os snapshots MAIS NOVOS (a
    // varredura é newest-first), que são os que mais importam — em vez de o V8 abortar o
    // processo inteiro com "Reached heap limit".
    const need = blobSize(root, snap, ARTICLES_REL) * META_HEAP_FACTOR;
    const free = heap().freeBytes;
    if (i > 0 && need > 0 && free < need) {
      report.memory.stoppedAt = 'metadata';
      warn(
        `restore: heap apertado (${mb(free)} MB livres, ${mb(need)} MB para o próximo snapshot) — ` +
          `parei em ${i} de ${snapshots.length} snapshots com ${union.size} artigos. ` +
          'Rode com mais heap (NODE_OPTIONS=--max-old-space-size=2048) para trazer o resto.',
      );
      break;
    }
    const meta = readJsonBuffer(read(META_REL), `meta.json de ${snap.label}`);
    const rows = readJsonBuffer(read(ARTICLES_REL), `articles.json de ${snap.label}`);
    metaBySnap.push(meta);
    const ids = new Map();
    idIndex.push(ids);
    const stat = { label: snap.label, kind: snap.kind, commit: snap.commit, date: snap.date, articles: 0, added: 0, bodies: 0 };
    report.snapshots.push(stat);
    if (!Array.isArray(rows)) {
      notePeak();
      continue;
    }
    stat.articles = rows.length;

    // meta.sources = [{id, name, count}] — o source_id do snapshot é de OUTRA base e só serve
    // como chave para achar o NOME (o remapeamento para o id local é do restoreFromGit).
    const srcName = new Map();
    for (const s of meta?.sources || []) {
      if (s && s.id != null && s.name) srcName.set(Number(s.id), String(s.name));
    }

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const url = normalizeUrl(row.url) || row.url || null;
      if (!url) continue;
      if (Number.isFinite(row.id)) ids.set(Number(row.id), url);
      let rec = union.get(url);
      if (!rec) {
        rec = { url, id: null, content: '', contentLen: 0, contentScore: -1, contentFrom: null, score: -1, from: null };
        union.set(url, rec);
        stat.added += 1;
      }
      // IDENTIDADE: só o snapshot MAIS NOVO (índice 0) dita ids. Reusar o id de um snapshot
      // antigo colidiria — cada wipe reiniciou o rowid em 1.
      if (i === 0 && Number.isFinite(row.id)) rec.id = Number(row.id);
      const score = metaRichness(row);
      // `>` (e não `>=`) faz o EMPATE ficar com o snapshot mais novo: a varredura é newest-first.
      if (score > rec.score) {
        rec.score = score;
        rec.from = snap.label;
        rec.title = row.title ?? null;
        rec.title_pt = row.title_pt ?? null;
        rec.summary_pt = row.summary_pt ?? null;
        rec.snippet = row.snippet ?? null;
        rec.date_iso = row.date_iso ?? null;
        rec.kind = row.kind ?? null;
        rec.section = row.section ?? null;
        rec.issue_url = row.issue_url ?? null;
        rec.verify_status = row.verify_status ?? null;
        rec.verify_notes = row.verify_notes ?? null;
        rec.tags = row.tags && typeof row.tags === 'object' ? row.tags : null;
        rec.source_name = srcName.get(Number(row.source_id)) || null;
      }
    }
    notePeak();
  }

  // ---- 3. passada de CORPOS (contents.json legado OU contents.partN.json) ----
  if (bodies) {
    const scoreBody = bodyScorer(policy);
    // ORÇAMENTO (antes de ler qualquer corpo): o que fica RETIDO é o corpo vencedor de cada URL,
    // ~ o tamanho dos contents do snapshot mais novo. `git cat-file -s` dá isso sem ler nada.
    let needBytes = 0;
    for (const f of contentsFiles(metaBySnap[0], () => null)) {
      needBytes += blobSize(root, snapshots[0], `${DATA_DIR_REL}/${f.file}`);
    }
    if (!needBytes) {
      for (let p = 0; p < MAX_PART_PROBE; p += 1) {
        const s = blobSize(root, snapshots[0], `${DATA_DIR_REL}/contents.part${p}.json`);
        if (!s) break;
        needBytes += s;
      }
      needBytes = needBytes || blobSize(root, snapshots[0], `${DATA_DIR_REL}/${CONTENTS_LEGACY}`);
    }
    needBytes = Math.round(needBytes * BODY_HEAP_FACTOR);
    report.memory.needMb = mb(needBytes);
    const freeNow = heap().freeBytes;
    if (needBytes > freeNow * MEM_PLAN_FRAC) {
      // Degradação com mensagem clara: METADADOS agora (resumo/tags/classificação: o que custou
      // LLM), corpos depois. Um corpo o crawler re-enriquece de graça; um resumo, não.
      report.memory.skippedBodies = true;
      warn(
        `restore: os corpos do acervo (~${mb(needBytes)} MB) não cabem no heap disponível ` +
          `(~${mb(freeNow)} MB livres de ${mb(heap().limitBytes)} MB). Restaurando SÓ os ` +
          'metadados (resumos, tags, classificações, frontier). Para trazer os corpos: ' +
          'NODE_OPTIONS=--max-old-space-size=2048 (ou o dobro do que falta).',
      );
    } else {
      let sinceCheck = 0;
      try {
        for (let i = 0; i < idIndex.length; i += 1) {
          const ids = idIndex[i];
          if (!ids.size) continue;
          // Com 'first', pula o snapshot inteiro quando nenhuma URL dele ainda precisa de corpo.
          // Com 'best'/'longest' o corte é POR LINHA (shouldRead), não por snapshot: só o
          // candidato que ainda pode vencer é materializado.
          if (policy === 'first') {
            let pending = 0;
            for (const url of ids.values()) {
              const rec = union.get(url);
              if (rec && !rec.contentLen) { pending += 1; break; }
            }
            if (!pending) continue;
          }
          const snap = snapshots[i];
          const read = snapshotReader(root, snap);
          const files = contentsFiles(metaBySnap[i], read);
          let got = 0;
          for (const { file, format, buf } of files) {
            if (heapTight()) throw new MemoryStop('bodies');
            const data = buf || read(`${DATA_DIR_REL}/${file}`);
            if (!data) continue;
            const shouldRead = (id, maxLen) => {
              const url = ids.get(id);
              if (!url) return false;
              const rec = union.get(url);
              // `maxLen` (tamanho da linha) é TETO do tamanho do corpo: se nem o teto bate a nota
              // atual, o candidato já perdeu e não vale o JSON.parse.
              return Boolean(rec) && (policy === 'first' ? rec.contentScore < 0 : maxLen > rec.contentScore);
            };
            scanContentsBuffer(
              data,
              (id, body) => {
                if (!body) return;
                const rec = union.get(ids.get(id));
                if (!rec) return;
                const score = scoreBody(body, rec);
                // nota 0 em 'best' = HTML CRU (substanceLength de um corpo não-vazio é >= 1):
                // conta como barrado quando perde para um texto de verdade.
                if (score === 0 && policy === 'best' && rec.contentScore > 0) report.bodiesRejectedHtml += 1;
                if (score <= rec.contentScore) return;
                rec.content = body;
                rec.contentLen = body.length;
                rec.contentScore = score;
                rec.contentFrom = snap.label;
                rec.contentFormat = format;
                got += 1;
                sinceCheck += 1;
                if (sinceCheck >= 256) {
                  sinceCheck = 0;
                  if (heapTight()) throw new MemoryStop('bodies');
                }
              },
              { shouldRead },
            );
            notePeak();
          }
          report.snapshots[i].bodies = got;
        }
      } catch (e) {
        if (!(e instanceof MemoryStop)) throw e;
        report.memory.stoppedAt = 'bodies';
        const h = heap();
        warn(
          `restore: heap no limite (${mb(h.usedBytes)} de ${mb(h.limitBytes)} MB) — parei de ler ` +
            'corpos e sigo com os que já vieram. Rode com NODE_OPTIONS=--max-old-space-size=2048 ' +
            'para completar.',
        );
      }
    }
  }

  // ---- 4. relatório ----
  const records = [];
  for (const rec of union.values()) {
    if (rec.score < 0) continue; // registro sem nenhuma linha de metadados (não deveria ocorrer)
    records.push(rec);
    report.articles += 1;
    if (rec.contentLen) {
      report.withBody += 1;
      if (rec.contentFormat === 'parts') report.bodiesFromParts += 1;
      else report.bodiesFromLegacy += 1;
    }
    if (rec.summary_pt) report.withSummary += 1;
    if (hasTags(rec.tags)) report.withTags += 1;
    if (rec.title_pt) report.withTitlePt += 1;
    if (rec.date_iso) report.withDate += 1;
    if (rec.issue_url) report.withIssueUrl += 1;
    if (rec.id != null) report.fromNewest += 1;
  }
  return finish(records);
}

// ---- aplicação na base ----

// O snapshot só carrega o NOME da fonte; o sources.json vivo dá base_url/type para o cadastro
// restaurado nascer completo (e casar com a fonte que o crawl vai semear).
function sourceHints() {
  const byName = new Map();
  try {
    for (const s of loadSources()) {
      if (s?.name) byName.set(String(s.name), { url: s.url || null, type: s.type || null });
    }
  } catch {
    /* sources.json ausente/ilegível: o restore cria a fonte só com o nome */
  }
  return byName;
}

/**
 * Repõe na base o que `collectFromGit` juntou, usando SÓ as funções de restore do db.js
 * (restoreSourceByName / restoreArticle / restoreTags / markUrlDone / restorePage).
 *
 * Garantias:
 *   - IDS DO SNAPSHOT MAIS NOVO PRESERVADOS; os demais registros recebem ids alocados acima do
 *     maior id já em uso (max entre o snapshot novo e o que a base já tem) — zero colisão.
 *   - `restoreTags(..., { markClassified: true })` é OBRIGATÓRIO e não-opcional por default: sem
 *     ele `listArticlesNeedingClassification` re-seleciona o acervo INTEIRO e o próximo
 *     crawl/finish re-classificaria 15 mil artigos × 9 facetas de LLM — o "recomeçar do zero"
 *     que o restore existe para impedir, só que na conta do usuário.
 *   - `markUrlDone` por artigo (senão o próximo crawl re-descobre tudo) e `restorePage` por
 *     `issue_url` DISTINTA quando o snapshot carrega o campo (degrada em silêncio sem ele).
 *   - TUDO numa transação só (15 mil linhas com fsync por item seria inviável).
 *   - Idempotente: a 2ª passada não duplica nada (todo INSERT é OR IGNORE).
 *
 * Opções: { root, ref, dryRun, limit, since, collected, bodyPolicy, marker, markClassified }.
 * `since` = data ISO (YYYY-MM-DD) mínima; `limit` = teto de artigos; `collected` reaproveita uma
 * coleta já feita (o dry-run da TUI, por exemplo). Retorna { report, before, after, ... }.
 */
export function restoreFromGit({
  root = ROOT,
  ref = '--all',
  dryRun = false,
  limit = 0,
  since = null,
  collected = null,
  bodyPolicy = RESTORE_BODY_POLICY,
  marker,
  markClassified = true,
} = {}) {
  const started = Date.now();
  const { records, report } = collected || collectFromGit({ root, ref, bodyPolicy, marker });
  const before = restoreCounts();

  let selected = records;
  if (since) selected = selected.filter((r) => r.date_iso && r.date_iso >= since);
  // Determinístico: primeiro os ids autoritativos (ASC), depois o resto por URL.
  selected = [...selected].sort((a, b) => {
    if (a.id != null && b.id != null) return a.id - b.id;
    if (a.id != null) return -1;
    if (b.id != null) return 1;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });
  if (limit > 0) selected = selected.slice(0, limit);

  const maxSnapshotId = selected.reduce((m, r) => (r.id != null && r.id > m ? r.id : m), 0);
  const maxDbId = stmts.maxArticleId.get().m || 0;
  let nextId = Math.max(maxSnapshotId, maxDbId) + 1;

  const out = {
    report,
    before,
    after: before,
    dryRun,
    selected: selected.length,
    inserted: 0,
    keptId: 0,
    freshId: 0,
    // motivos por LINHA (url/hash/bad-source/id-taken). Nome distinto do `skipped` do
    // maybeAutoRestore (motivo do BOOTSTRAP não ter rodado): os dois objetos se misturam no spread.
    skippedRows: {},
    tags: 0,
    classifications: 0,
    frontier: 0,
    pages: 0,
    sources: 0,
    ms: 0,
  };
  if (!selected.length) {
    out.ms = Date.now() - started;
    return out;
  }

  // Remapeamento das fontes ANTES do laço: passar o source_id CRU do snapshot devolveria
  // reason:'bad-source' em todas as linhas (os ids são de outra base — contrato do db.js).
  const hints = sourceHints();
  const srcIds = new Map();
  const localSourceId = (name) => {
    if (!name) return null;
    if (srcIds.has(name)) return srcIds.get(name);
    const hint = hints.get(name) || {};
    const res = restoreSourceByName(name, hint.url || null, hint.type || null);
    if (res.created) out.sources += 1;
    srcIds.set(name, res.id);
    return res.id;
  };

  if (dryRun) {
    for (const r of selected) {
      if (r.id != null) out.keptId += 1;
      else out.freshId += 1;
    }
    out.ms = Date.now() - started;
    return out;
  }

  const issues = new Map(); // issue_url -> source_id local (restorePage 1x por issue distinta)
  const apply = db.transaction(() => {
    for (const rec of selected) {
      const sourceId = localSourceId(rec.source_name);
      const explicitId = rec.id != null ? rec.id : nextId;
      if (rec.id != null) out.keptId += 1;
      else {
        out.freshId += 1;
        nextId += 1;
      }
      const res = restoreArticle({
        // `local_id` (e não `id`): o db.js IGNORA o `id` cru do snapshot de propósito — quem
        // decide preservar um id é este módulo, que já resolveu a identidade pela URL.
        local_id: explicitId,
        source_id: sourceId,
        url: rec.url,
        title: rec.title,
        title_pt: rec.title_pt,
        summary_pt: rec.summary_pt,
        content: rec.content || '',
        // Sem corpo, o snippet do snapshot vira o blurb — a ficha não fica em branco na UI (e
        // NUNCA vira `content`: são 400 caracteres, e gravá-los como corpo daria um
        // content_hash de texto truncado, indistinguível de um artigo completo).
        blurb: rec.contentLen ? null : rec.snippet || null,
        published_at: rec.date_iso,
        kind: rec.kind,
        section: rec.section,
        issue_url: rec.issue_url,
        verify_status: rec.verify_status,
        verify_notes: rec.verify_notes,
      });
      if (res.inserted) out.inserted += 1;
      else out.skippedRows[res.reason || 'ignored'] = (out.skippedRows[res.reason || 'ignored'] || 0) + 1;
      // Tags só quando a linha é DESTA url (inserida agora, ou a mesma já presente). Em
      // `reason:'hash'` o id devolvido é de OUTRA url com conteúdo byte-a-byte idêntico (a
      // mesma dedup do crawler) — carimbar nela as tags deste registro seria contaminação.
      // Só quem TEM tags ganha a linha 'restored'. Um artigo sem tag nenhuma no snapshot NUNCA
      // foi classificado — carimbá-lo como classificado o deixaria fora do sweep para sempre.
      if (res.id && (res.inserted || res.reason === 'url') && hasTags(rec.tags)) {
        const t = restoreTags(res.id, rec.tags, { markClassified });
        out.tags += t.tags;
        if (t.classification) out.classifications += 1;
      }
      // A frontier é marcada SEMPRE que a URL foi resolvida — inclusive na dedup por hash: a
      // URL é território conhecido de qualquer jeito, e sem isso o próximo crawl a re-descobre.
      if (res.id || res.reason === 'hash') {
        const mark = markUrlDone(rec.url, 'article', sourceId);
        if (mark.marked) out.frontier += 1;
      }
      if (rec.issue_url && !issues.has(rec.issue_url)) issues.set(rec.issue_url, sourceId);
    }
    // `restorePage` só tem entrada quando o export carrega `issue_url` (contrato documentado no
    // db.js); sem o campo, este laço roda vazio e o restore degrada sem erro.
    for (const [url, sourceId] of issues) if (restorePage(url, sourceId)) out.pages += 1;
  });
  apply();

  out.after = restoreCounts();
  out.ms = Date.now() - started;
  return out;
}

// ---- bootstrap automático ----

/**
 * Sob teste? O auto-restore JAMAIS pode disparar numa suíte: 44 arquivos de teste rodam com
 * NC_HOME em tmpdir e cwd no repo — um auto-restore ali populava os bancos temporários com 15
 * mil artigos e quebrava tudo. Só sinais INEQUÍVOCOS do runner contam:
 *   - NODE_TEST_CONTEXT (o `node --test` o injeta em cada arquivo-filho);
 *   - o argv tem `--test` ou aponta para um `*.test.js` (rodar o arquivo direto);
 *   - NC_UNDER_TEST=1 (escotilha explícita para um runner exótico).
 *
 * DOIS SINAIS FORAM REMOVIDOS por darem falso-positivo — e falso-positivo aqui é o usuário nunca
 * ter bootstrap e concluir que a funcionalidade não existe:
 *   - `NODE_ENV=test`: é convenção de aplicação, não de runner; quem tem essa variável exportada
 *     no shell (comum) perderia o restore em produção;
 *   - "NC_HOME dentro de os.tmpdir()": dependia do TMPDIR do processo (nesta máquina
 *     `os.tmpdir()` é /var/tmp/user-1000, então um NC_HOME=/tmp/... NÃO era detectado) — uma
 *     regra que errava dos dois lados. O isolamento da suíte não depende dela: todo arquivo de
 *     teste roda sob `node --test`.
 * NC_NO_AUTO_RESTORE=1 continua desligando o bootstrap, mas com motivo PRÓPRIO ('disabled-env')
 * em vez de se disfarçar de "estou sob teste".
 */
export function isUnderTest() {
  if (process.env.NODE_TEST_CONTEXT) return true;
  if (process.env.NC_UNDER_TEST === '1') return true;
  return process.argv.some((a) => a === '--test' || /\.test\.(m|c)?js$/.test(a));
}

// Motivo do BOOTSTRAP não ter rodado, em português e com a saída (o que fazer para mudar). Um
// bootstrap que pula em SILÊNCIO é indistinguível de um bootstrap quebrado: todo pulo é logado.
const SKIP_WHY = {
  disabled: 'desligado (CRAWLER_AUTO_RESTORE=false ou --no-restore)',
  'disabled-env': 'desligado por NC_NO_AUTO_RESTORE=1',
  'test-env': 'processo sob a suíte de testes (NODE_TEST_CONTEXT/--test)',
  'db-error': 'base ilegível',
  'db-not-empty': 'a base já tem artigos (restore repõe, não sincroniza)',
  'no-git': 'este diretório não é um repositório git',
  'shallow-no-history': 'clone raso (--depth 1): sem histórico para restaurar (git fetch --unshallow)',
  'no-snapshot': 'nenhum snapshot no histórico (ou tudo antes do marcador de wipe)',
  error: 'falhou',
};

/**
 * POLÍTICA DO BOOTSTRAP — o requisito literal do usuário: "qualquer projeto que clonar esse e
 * quiser pegar dados, por padrão já recupera todos os dados que tem no git".
 * Se a base está VAZIA **e** o histórico do git tem snapshot, restaura sozinho, em vez de deixar
 * o crawler coletar do zero (~600 issues por fonte, US$ de LLM, horas).
 *
 * NUNCA dispara: com a base NÃO-vazia (restore é reposição, não sincronização), sob a suíte de
 * testes (isUnderTest), com CRAWLER_AUTO_RESTORE=false ou com `enabled: false` (o `--no-restore`
 * da CLI). Fail-open em tudo: sem git, sem histórico, snapshot ilegível ou erro de escrita ⇒
 * avisa e devolve `{ ran: false, skipped }`, nunca derruba o comando que chamou. TODO pulo é
 * LOGADO com o motivo (só `quiet: true` cala) — silêncio aqui é indistinguível de bug.
 * A única falha que o `try/catch` NÃO pegaria é o `FATAL ERROR: Reached heap limit` (abort do
 * V8, não exceção); por isso o orçamento de memória do collect degrada ANTES de estourar.
 *
 * Retorna { ran, skipped, articles, ...resultado do restoreFromGit }.
 */
export function maybeAutoRestore({
  root = ROOT,
  reason = 'bootstrap',
  enabled = AUTO_RESTORE,
  force = false,
  ref = '--all',
  quiet = false,
} = {}) {
  const skip = (why, detail = null) => {
    if (!quiet) log(`restore automático não rodou: ${SKIP_WHY[why] || why}${detail ? ` — ${detail}` : ''}.`);
    return { ran: false, skipped: why, reason };
  };
  try {
    if (!force) {
      if (!enabled) return skip('disabled');
      if (process.env.NC_NO_AUTO_RESTORE === '1') return skip('disabled-env');
      if (isUnderTest()) return skip('test-env');
    }
    let existing = 0;
    try {
      existing = countArticles();
    } catch (e) {
      return skip('db-error', e.message);
    }
    if (existing > 0) return skip('db-not-empty', `${existing} artigos`);
    if (!isGitRepo(root)) return skip('no-git', root);

    const collected = collectFromGit({ root, ref });
    if (!collected.records.length) return skip(collected.report.shallow ? 'shallow-no-history' : 'no-snapshot');

    if (!quiet) {
      log(
        `base vazia + snapshot no git: restaurando ${collected.records.length} artigos ` +
          `(${collected.report.withBody} com corpo, ${collected.report.commits} commits de dados)…`,
      );
    }
    const res = restoreFromGit({ root, ref, collected });
    if (!quiet) {
      log(
        `restore: ${res.inserted} artigos repostos (${res.keptId} com o id do snapshot, ` +
          `${res.freshId} com id novo), ${res.tags} tags, ${res.classifications} classificações ` +
          `marcadas, ${res.frontier} URLs na frontier — ${(res.ms / 1000).toFixed(1)}s.`,
      );
      const mem = collected.report.memory;
      if (mem?.skippedBodies || mem?.stoppedAt) {
        log(
          'restore: a coleta foi DEGRADADA por memória (ver o aviso acima) — os metadados estão ' +
            'de pé; rode de novo com mais heap para completar os corpos.',
        );
      }
      log('Desligue com CRAWLER_AUTO_RESTORE=false (ou --no-restore).');
    }
    return { ran: true, skipped: null, reason, ...res };
  } catch (e) {
    warn(`restore automático falhou (${e.message}) — o comando segue com a base como está.`);
    return { ran: false, skipped: 'error', reason };
  }
}
