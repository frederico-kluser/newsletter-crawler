// Deploy do site: exporta o snapshot do webapp + a API pública, publica na branch de produção e
// ESPERA a Vercel confirmar a publicação. O "confirmar" é o ponto: a Vercel publica por Git
// integration, então o push é só o GATILHO — a única prova de que o site está no ar sem credencial
// da Vercel é ler o snapshot SERVIDO (SITE_URL + SITE_META_PATH) e ver o `generatedAt` do HEAD
// pós-push aparecer lá. Sem isso, um build quebrado passa por "deploy ✓".
//
// Ordem: preflight (git/branch/remoto) → ahead/behind (remoto à frente ABORTA aqui, antes de
// qualquer escrita na árvore) → estado do HEAD + do site no ar → export (com o GUARD
// anti-encolhimento armado) → mudança real → decisão → commit → push (--no-verify: o hook pre-push
// faria o MESMO export de novo e abortaria o push) → polling até publicar.
//
// O ahead/behind vem ANTES do export de propósito: "repo atrasado" é o caso mais comum do fluxo
// multi-máquina e o diagnóstico dele ("git pull --rebase") tem de chegar primeiro. Com o export na
// frente, um repo atrasado levava o bloqueio do guard ("o snapshot novo tem MENOS artigos que o já
// publicado") — fail-safe, mas culpando a base local, que estava correta.
//
// Fail-open onde o custo de errar é baixo (fetch/rede/leitura do site), fail-closed onde publicar
// errado é caro (branch errada, remoto à frente, repo sem git): esses ABORTAM antes de tocar no git.
//
// O guard anti-encolhimento (`src/snapshot-guard.js`) é o ponto em que essa política se inverte de
// vez: publicar um snapshot menor que o acervo NO AR destrói a base de registro (o histórico do
// git), então ele é fail-SAFE — na dúvida, bloqueia. Ele existe por causa de 2026-08-24 (commit
// 7c24491): 0 artigos publicados por cima de 2866. O deploy tinha os dois números e só os logava.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync, readFileSync as fsReadFileSync, writeFileSync as fsWriteFileSync } from 'node:fs';
import got from 'got';
import {
  ROOT, SITE_URL, SITE_META_PATH, DEPLOY_BRANCH, DEPLOY_WAIT_MS, DEPLOY_POLL_MS,
} from './config.js';
import { exportWebSnapshot } from './export-web.js';
import { exportPublicApi } from './export-api.js';
import { evaluateSnapshotChange } from './snapshot-guard.js';
import { log, warn } from './util.js';

// Caminhos (relativos ao repo) que o deploy é dono de commitar.
const DATA_REL = 'webapp/public/data';
const API_REL = 'webapp/public/api/v1';
const META_REL = `${DATA_REL}/meta.json`;
const CORPUS_REL = `${API_REL}/corpus.json`;
// Só estes dois carregam o campo volátil `generatedAt` (o resto do diff é dado de verdade).
const VOLATILE_REL = [META_REL, CORPUS_REL];
// TUDO o que o export escreve na árvore. O export reescreve também `articles.json` e os
// `contents.partN.json`, então desfazer só os dois voláteis deixava o snapshot ESVAZIADO no
// working tree — pronto p/ o próximo `git add` levá-lo ao commit com o guard "funcionando".
const SNAPSHOT_REL = [DATA_REL, API_REL];
// Os arquivos que o export ESCREVE, e só eles: meta/articles/corpus, mais a família variável
// `contents.partN.json` (o export cria e remove partes conforme o acervo cresce; `contents.json`
// é o arquivo único de antes da partição, que ele apaga). É esta lista — e não "tudo o que estiver
// nos diretórios" — que define o que o deploy pode remover da árvore de trabalho.
const rxEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EXPORT_ARTIFACT_RE = new RegExp(
  `^(?:${rxEscape(DATA_REL)}/(?:meta\\.json|articles\\.json|contents\\.json|contents\\.part\\d+\\.json)` +
    `|${rxEscape(API_REL)}/corpus\\.json)$`,
);

/** Este caminho (relativo ao repo) é um arquivo que o export gera? Pura: os testes fixam a lista. */
export function isExportArtifact(rel) {
  return EXPORT_ARTIFACT_RE.test(String(rel || '').trim().replace(/^"|"$/g, ''));
}

// Erro de deploy com mensagem já pronta p/ o usuário (o CLI/TUI só imprime `.message` + `.hint`).
export class DeployError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'DeployError';
    this.hint = hint || null;
  }
}

// ---- helpers puros (testáveis sem git/rede) ----

/**
 * Dado um `git diff -U0` de um arquivo de snapshot, diz se a ÚNICA mudança é o `generatedAt`.
 * Comparar por DIFF (e não carregando os dois arquivos) é deliberado: o corpus.json tem MBs e o
 * `git show` estourava o maxBuffer do execFileSync — o erro virava "mudou" e o deploy republicava
 * o mesmo snapshot a cada run. O export usa indent 1 (um campo por linha), então o generatedAt é
 * exatamente uma linha -/+.
 */
export function diffIsOnlyVolatile(diff) {
  const lines = String(diff || '')
    .split('\n')
    .filter((l) => /^[+-]/.test(l) && !l.startsWith('+++') && !l.startsWith('---'));
  return lines.length > 0 && lines.every((l) => l.includes('"generatedAt"'));
}

// Lê `generatedAt` + total de artigos de um meta.json (string ou objeto). Fail-open: null.
export function readSnapshotStamp(raw) {
  try {
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!m || typeof m.generatedAt !== 'string') return null;
    const articles = Number(m?.totals?.articles);
    return { generatedAt: m.generatedAt, articles: Number.isFinite(articles) ? articles : null };
  } catch {
    return null;
  }
}

// Separa `git status --porcelain` em caminhos DE DADOS (que o deploy commita) e o resto (código).
// `untracked` fica de fora do que é commitável: um `.env`/diretório de rascunho jamais entra
// num deploy por acidente.
export function splitDirtyPaths(porcelain) {
  const data = [];
  const code = [];
  const untracked = [];
  for (const raw of String(porcelain || '').split('\n')) {
    if (raw.length < 4) continue;
    // Formato porcelain v1 = "XY<espaço>arquivo". Se o 3º caractere não é espaço, a linha perdeu o
    // espaço-de-status inicial (um trim a montante) — re-põe, senão o nome sai cortado.
    const line = raw[2] === ' ' ? raw : ` ${raw}`;
    const status = line.slice(0, 2);
    // Renomeado ("R  velho -> novo"): o caminho que interessa é o destino.
    const file = line.slice(3).split(' -> ').pop().trim().replace(/^"|"$/g, '');
    if (!file) continue;
    if (status === '??') untracked.push(file);
    else if (file.startsWith(DATA_REL) || file.startsWith(API_REL)) data.push(file);
    else code.push(file);
  }
  return { data, code, untracked };
}

/**
 * Decide o que o deploy vai fazer. PURA de propósito: é a regra de negócio do comando e o que os
 * testes fixam. `live` é o stamp do site no ar (null = não deu pra ler → não bloqueia nada).
 * `refresh` = precisamos gerar um snapshot NOVO (bump do generatedAt) p/ ter o que publicar.
 */
export function planDeploy({ dataChanged, codeChanged, ahead, live, localStamp, force }) {
  const siteKnown = Boolean(live && localStamp);
  // O site está em dia se serve exatamente o snapshot que temos aqui.
  const siteInSync = siteKnown ? live.generatedAt === localStamp.generatedAt : null;

  if (force) return { publish: true, refresh: true, reason: 'force' };
  if (dataChanged) return { publish: true, refresh: false, reason: 'data' };
  // Código do webapp muda o SITE mesmo sem dado novo. `refresh` é obrigatório aqui: sem bumpar o
  // generatedAt, o alvo do polling seria o stamp que o site JÁ serve — confirmação falsa.
  if (codeChanged) return { publish: true, refresh: true, reason: 'code' };
  if (ahead > 0) return { publish: true, refresh: false, reason: 'unpushed' };
  // Dados iguais aos do HEAD e nada pendente, mas o site serve outra coisa: deploy anterior nunca
  // chegou (build falhou / push perdido). Republica com um snapshot novo p/ disparar outro build.
  if (siteInSync === false) return { publish: true, refresh: true, reason: 'site-behind' };
  return { publish: false, refresh: false, reason: siteKnown ? 'up-to-date' : 'no-change' };
}

/**
 * Hint EXTRA do bloqueio: o snapshot já COMMITADO no HEAD também está abaixo do que o site serve.
 * Aí re-exportar não basta — os commits pendentes, sozinhos, encolheriam o acervo, e o conserto é
 * no commit (revert / commitar por cima com o banco completo).
 *
 * Isto substitui um guard de etapa `push` que existia logo antes do `git push` e era INALCANÇÁVEL:
 * chegar lá exigia "nada novo p/ commitar" (⇒ o snapshot exportado é igual ao do HEAD) e o guard do
 * export já tinha exigido novo >= max(head, live) (⇒ head >= live), então ele SEMPRE liberava. O
 * diagnóstico que ele carregava, porém, é real — e cabe aqui, onde os três números existem e o
 * bloqueio de fato acontece.
 */
function hintHeadAbaixoDoAr({ head, live }) {
  if (head == null || live == null || head >= live) return null;
  return (
    `ATENÇÃO: o snapshot que JÁ ESTÁ COMMITADO no HEAD tem ${head} artigo(s) e o site serve ${live} — ` +
    `mesmo sem commitar nada agora, publicar os commits pendentes encolheria o acervo. Re-exporte ` +
    `com o banco COMPLETO e commite por cima, ou desfaça o commit que encolheu o snapshot ` +
    `(\`git revert <sha>\`) antes de publicar.`
  );
}

/**
 * Guard anti-encolhimento NO CAMINHO DO DEPLOY: aplica a decisão pura de `snapshot-guard.js` e a
 * converte no vocabulário do comando (DeployError com `.message`/`.hint`, que o CLI e a TUI já
 * imprimem). PURA fora do `restore`/`warn` — é ela que os testes fixam.
 *
 * Por que existe: em 2026-08-24 (commit 7c24491) o deploy publicou 0 artigos por cima de 2866. Os
 * dois números estavam na mão dele ("export web: 0 artigos" / "site no ar: 2866 artigos") e só
 * viravam log — nunca chegavam a uma decisão. Aqui eles decidem.
 *
 * @param {number|null} o.novo   total do snapshot que seria publicado
 * @param {number|null} o.head   total commitado no HEAD (null = desconhecido)
 * @param {number|null} o.live   total servido pelo site no ar (null = desconhecido)
 * @param {boolean|string} o.allowShrink  opt-in do usuário (`--allow-shrink` / `--allow-shrink wipe`)
 * @param {Function|null} o.restore  chamado ANTES de abortar (devolve a árvore ao estado do HEAD)
 * @returns {object} o veredito (allow); lança DeployError quando bloqueia
 */
export function guardSnapshot({ novo, head, live, allowShrink, restore = null } = {}) {
  const v = evaluateSnapshotChange({ novo, head, live, allowShrink });
  if (v.action === 'block') {
    // Restaura ANTES de abortar: o export já reescreveu os JSONs da árvore e um snapshot esvaziado
    // esperando o próximo `git add` é exatamente como o dado se perde com o guard "ativo".
    if (restore) restore();
    // `v.counts` já vem normalizado (string do hook, número, null) — usa ele, não os brutos.
    const extra = hintHeadAbaixoDoAr(v.counts);
    throw new DeployError(v.message, [v.hint, extra].filter(Boolean).join(' ') || null);
  }
  if (v.override) {
    // Único caminho que apaga acervo publicado DE PROPÓSITO — não pode passar despercebido.
    warn(`ATENÇÃO — ${v.message}`);
    warn('ATENÇÃO — o histórico do git é a base de registro do acervo: isto não se desfaz pelo site.');
  }
  return v;
}

export function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}min ${String(s % 60).padStart(2, '0')}s`;
}

// ---- git (execFileSync com argv em array: sem shell, sem escape de path) ----

function git(args, { allowFail = false } = {}) {
  try {
    // Só o fim é aparado: `.trim()` comeria o espaço INICIAL da 1ª linha do `status --porcelain`
    // (" M arq" → "M arq"), deslocando o nome do arquivo em um caractere.
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
      // O default de 1 MB estoura em qualquer coisa que toque o snapshot (corpus.json tem ~7 MB,
      // articles.json ~30 MB) — e o ENOBUFS virava "mudou", republicando o mesmo dado toda run.
      maxBuffer: 64 * 1024 * 1024,
      // Sem prompt de credencial: um fetch/push que pediria senha falha na hora com mensagem em vez
      // de PENDURAR o comando (que também espera o build depois).
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).replace(/\s+$/, '');
  } catch (e) {
    if (allowFail) return null;
    const detail = [e.stderr, e.stdout, e.message].map((x) => String(x || '').trim()).find(Boolean);
    throw new DeployError(`git ${args[0]} falhou: ${detail}`);
  }
}

// Conteúdo de um arquivo no HEAD (null se não existe lá — primeiro commit do snapshot).
// `run` é o executor de git (o real, ou a costura de teste — ver runDeploy).
function showHead(run, rel) {
  return run(['show', `HEAD:${rel}`], { allowFail: true });
}

// Mudança real num arquivo que carrega o `generatedAt`: ausente no HEAD = mudança; diff vazio =
// igual; senão pergunta ao diff se sobrou algo além do campo volátil.
function changedIgnoringVolatile(run, rel) {
  if (run(['cat-file', '-e', `HEAD:${rel}`], { allowFail: true }) === null) return true;
  const diff = run(['diff', '-U0', 'HEAD', '--', rel], { allowFail: true });
  if (diff === null) return true; // não deu p/ comparar: assume mudança (melhor republicar que sumir)
  if (diff === '') return false;
  return !diffIsOnlyVolatile(diff);
}

// Redação anterior do helper de credencial: o push do deploy via menu falhava com
// "Invalid username or token. Password authentication is not supported for Git operations."
// quando o git usava um token ESTÁTICO expirado do ~/.git-credentials (store) em vez da
// credencial viva do `gh` CLI. Este helper garante, antes do push, que github.com autentique via
// `gh auth git-credential` (token atual ✓) e saneia o store p/ não mandar token velho. Fail-open:
// se o gh não estiver disponível, segue e o push mostra o erro com hint acionável.
// Detecção pura (testável): o remote é HTTPS de github.com? (o único caso que precisa do gh).
export function isGithubHttpsRemote(url) {
  const s = String(url || '');
  return /github\.com/i.test(s) && /^https?:\/\//i.test(s);
}

function ensureGithubGitAuth(remoteUrl) {
  const url = String(remoteUrl || '');
  const github = isGithubHttpsRemote(url);
  const hinted = [];
  if (!github) return { gh: false, github: false, hinted };
  let ghBin = null;
  try { ghBin = execFileSync('which', ['gh'], { encoding: 'utf8' }).trim(); } catch {}
  if (!ghBin) {
    hinted.push("gh CLI não encontrado — instale (github.com/cli) e rode `gh auth login`; ou sete o remote com um PAT de escopo repo: `git remote set-url origin https://<USUARIO>:<PAT>@github.com/<org>/<repo>.git`.");
    return { gh: false, github: true, hinted };
  }
  // 1) Garante o helper do gh p/ github.com (idempotente).
  try {
    execFileSync('git', ['config', '--global', 'credential.https://github.com.helper', `!${ghBin} auth git-credential`], { stdio: 'pipe' });
  } catch {}
  // 2) Saneia o store: remove a linha github.com (token estático pode estar expirado e, listado
  //    antes do helper do gh, o git o usaria e o GitHub respondería "Invalid username or token").
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    const credFile = path.join(home, '.git-credentials');
    try {
      if (existsSync(credFile)) {
        const raw = fsReadFileSync(credFile, 'utf8');
        const hadGithub = raw.split('\n').some((l) => /@github\.com$/.test(l.trim()));
        if (hadGithub) {
          fsWriteFileSync(credFile, raw.split('\n').filter((l) => !/@github\.com$/.test(l.trim())).join('\n'));
          hinted.push('token github.com antigo removido de ~/.git-credentials — o deploy usa a credencial do `gh`.');
        }
      }
    } catch {}
  }
  return { gh: true, github: true, hinted };
}

function preflight(run) {
  const top = run(['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!top) throw new DeployError('isto não é um repositório git — o deploy publica via git push.');

  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== DEPLOY_BRANCH) {
    throw new DeployError(
      `o deploy publica a branch "${DEPLOY_BRANCH}", mas você está em "${branch}".`,
      `troque de branch (git switch ${DEPLOY_BRANCH}) ou faça o merge antes — ` +
        'publicar daqui empurraria a main ANTIGA, sem as suas mudanças.',
    );
  }

  const remotes = (run(['remote'], { allowFail: true }) || '').split('\n').filter(Boolean);
  if (!remotes.includes('origin')) {
    throw new DeployError(
      'nenhum remoto "origin" configurado — a Vercel publica a partir do push.',
      'git remote add origin <url-do-repo>',
    );
  }
  const remoteUrl = run(['remote', 'get-url', 'origin'], { allowFail: true });
  for (const h of ensureGithubGitAuth(remoteUrl).hinted) warn(h);
  return { branch, remoteUrl };
}

// Conta os commits só-nossos e só-do-remoto. Precisa de `git fetch`: fail-open (offline → o push
// falha depois com mensagem clara, não vale abortar aqui).
function divergence(run) {
  const fetched = run(['fetch', '--quiet', 'origin', DEPLOY_BRANCH], { allowFail: true }) !== null;
  if (!fetched) {
    warn('não deu para consultar o origin (offline?) — seguindo com o estado local.');
    return { ahead: 0, behind: 0, known: false };
  }
  const counts = run(['rev-list', '--left-right', '--count', `origin/${DEPLOY_BRANCH}...HEAD`], {
    allowFail: true,
  });
  const [behind, ahead] = String(counts || '0\t0').split(/\s+/).map((n) => Number(n) || 0);
  return { ahead, behind, known: true };
}

// ---- site no ar ----

// Lê o snapshot SERVIDO. Cache-bust por query (chave de cache do CDN muda) + no-cache no request:
// sem isso a borda da Vercel devolveria o meta.json antigo e o polling nunca convergiria.
export async function fetchLiveStamp({ timeoutMs = 15000 } = {}) {
  const url = `${SITE_URL}${SITE_META_PATH}?t=${Date.now()}`;
  try {
    const res = await got(url, {
      timeout: { request: timeoutMs },
      retry: { limit: 0 },
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
      throwHttpErrors: true,
    });
    return readSnapshotStamp(res.body);
  } catch {
    return null; // site fora do ar / sem rede / JSON inválido: quem chama decide
  }
}

// Espera o site servir `expected` (o generatedAt do HEAD). Resolve { ok, elapsedMs, live }.
async function waitForPublish(expected, { waitMs = DEPLOY_WAIT_MS, pollMs = DEPLOY_POLL_MS } = {}) {
  const startedAt = Date.now();
  let attempt = 0;
  let last = null;
  log(`aguardando a Vercel publicar (limite ${fmtElapsed(waitMs)}, sondando ${SITE_URL}${SITE_META_PATH})…`);
  while (Date.now() - startedAt < waitMs) {
    attempt++;
    last = await fetchLiveStamp();
    if (last?.generatedAt === expected) {
      return { ok: true, elapsedMs: Date.now() - startedAt, live: last, attempts: attempt };
    }
    const elapsed = fmtElapsed(Date.now() - startedAt);
    const atual = last ? `no ar: ${last.articles ?? '?'} artigos (${last.generatedAt})` : 'site não respondeu';
    log(`  ${elapsed} — build em andamento; ${atual}`);
    // Não estoura o limite dormindo: a última espera é encurtada. O timer NÃO é unref'd de
    // propósito — ele é a única coisa segurando o event loop enquanto esperamos o build.
    const left = waitMs - (Date.now() - startedAt);
    if (left <= 0) break;
    await new Promise((r) => { setTimeout(r, Math.min(pollMs, left)); });
  }
  return { ok: false, elapsedMs: Date.now() - startedAt, live: last, attempts: attempt };
}

// ---- orquestração ----

/**
 * Publica o site de ponta a ponta. Retorna um resultado TIPADO (a TUI e o CLI formatam):
 *   { status: 'live'|'pushed'|'timeout'|'up-to-date'|'dry-run', ... }
 * Lança DeployError nas condições que abortam antes de mexer no git.
 * flags: { force, 'no-wait', 'dry-run', 'include-code', 'allow-shrink', timeout }
 *
 * `deps` é COSTURA DE TESTE (git/export/site injetáveis): a orquestração — inclusive o guard
 * anti-encolhimento — precisa ser exercitável de ponta a ponta sem tocar num repositório real,
 * porque o bug que ela existe p/ evitar (7c24491) só aparece na SEQUÊNCIA das etapas.
 */
export async function runDeploy(flags = {}, deps = {}) {
  const {
    git: run = git,
    exportWeb = exportWebSnapshot,
    exportApi = exportPublicApi,
    fetchLive = fetchLiveStamp,
  } = deps;
  const force = flags.force === true || flags.force === 'true';
  const noWait = flags['no-wait'] === true || flags['no-wait'] === 'true';
  const dryRun = flags['dry-run'] === true || flags['dry-run'] === 'true';
  const includeCode = flags['include-code'] === true || flags['include-code'] === 'true';
  // Opt-in do guard anti-encolhimento. Repassado CRU (o guard normaliza): `--allow-shrink` chega
  // como `true` e `--allow-shrink wipe` como a string 'wipe'. A forma com `=` NÃO existe — o
  // parseFlags de index.js não quebra em `=` (viraria a flag literal "allow-shrink=wipe").
  const allowShrink = flags['allow-shrink'];
  const waitMs = Number(flags.timeout) > 0 ? Number(flags.timeout) * 1000 : DEPLOY_WAIT_MS;

  const { branch } = preflight(run);

  // 1. Código pendente: nunca entra por acidente. Sem --include-code, só avisa.
  const dirty = splitDirtyPaths(run(['status', '--porcelain'], { allowFail: true }) || '');
  if (dirty.code.length) {
    const lista = dirty.code.slice(0, 10).map((f) => `   ${f}`).join('\n');
    const resto = dirty.code.length > 10 ? `\n   … +${dirty.code.length - 10}` : '';
    if (includeCode) log(`--include-code: ${dirty.code.length} arquivo(s) de código entram no commit:\n${lista}${resto}`);
    else {
      warn(
        `${dirty.code.length} arquivo(s) de código NÃO commitado(s) ficam FORA do deploy ` +
          `(a Vercel publica o que está na ${branch}):\n${lista}${resto}\n` +
          '   use --include-code p/ commitá-los junto, ou commite-os antes.',
      );
    }
  }

  // 2. Divergência com o remoto ANTES de tocar na árvore: remoto à frente = push rejeitado, e o
  //    conselho é `git pull --rebase`. Vem aqui (e não depois do export) porque "repo atrasado" é o
  //    caso mais comum do fluxo multi-máquina: com o export na frente, o usuário levava o bloqueio
  //    do guard ("o snapshot novo tem MENOS artigos que o já publicado"), que culpa a base local —
  //    correta — em vez de mandar sincronizar. Abortando aqui, nada foi escrito: nem restore é
  //    preciso.
  const { ahead, behind } = divergence(run);
  if (behind > 0) {
    throw new DeployError(
      `o origin/${branch} está ${behind} commit(s) à frente — o push seria rejeitado.`,
      `rode "git pull --rebase origin ${branch}" e tente de novo. Enquanto o repo está atrasado, ` +
        'o snapshot local pode ser MENOR que o publicado sem que a sua base tenha problema algum.',
    );
  }

  // 3. BASE DE COMPARAÇÃO do guard, lida ANTES do export: o total commitado no HEAD e o total que
  //    o site serve. Ler o site aqui (e não lá embaixo, só p/ decidir se ele está atrasado) é o
  //    que ARMA o guard anti-encolhimento — em 7c24491 esse número já era conhecido e só virava
  //    log. `localStamp` sai do HEAD (não da árvore): o export vai bumpar o generatedAt dela.
  const localStamp = readSnapshotStamp(showHead(run, META_REL));
  const live = await fetchLive();
  if (live) log(`site no ar: ${live.articles ?? '?'} artigos (${live.generatedAt})`);
  else warn(`não deu para ler ${SITE_URL}${SITE_META_PATH} — sigo sem comparar com o que está no ar.`);

  // 4. Export (é o mesmo que o hook pre-push faz; sempre bate o generatedAt), com o guard ARMADO.
  //    `live` + `allowShrink` seguem junto p/ o export: na versão COM guard interno (branch irmã
  //    `onda2-export-guard`) são eles que o deixam recusar sozinho — o que protege também quem roda
  //    `ncrawl export` fora do deploy. A `exportWebSnapshot` de hoje IGNORA os dois (options extras
  //    não atrapalham), então quem garante o bloqueio agora é o SEGUNDO CERCO logo abaixo, com os
  //    três números na mão. Se o export recusar, o erro TIPADO (`SnapshotShrinkError` / `.verdict`)
  //    vira DeployError aqui.
  log('exportando o snapshot do webapp a partir do banco local…');
  let web;
  try {
    web = exportWeb({ outDir: path.join(ROOT, DATA_REL), allowShrink, live });
  } catch (e) {
    // O export pode ter escrito parte dos arquivos antes de recusar: a árvore volta ao HEAD.
    restoreSnapshot(run);
    if (e?.verdict || e?.name === 'SnapshotShrinkError') throw new DeployError(e.message, e.hint);
    throw e;
  }
  const api = exportApi({ outDir: path.join(ROOT, API_REL) });
  // Segundo cerco, no caminho do DEPLOY: a MESMA regra, decidida aqui com os três números na mão.
  // Não depende do guard interno do export (que serve ao `ncrawl export` e ao hook).
  guardSnapshot({
    novo: web?.articles,
    head: localStamp?.articles ?? null,
    live: live?.articles ?? null,
    allowShrink,
    restore: () => restoreSnapshot(run),
  });

  // 5. Mudança REAL = algo no dir de dados difere do HEAD, ignorando o generatedAt volátil.
  //    `git diff` NÃO enxerga arquivo novo não-rastreado e o export criou/removeu arquivos
  //    (a 1ª rodada pós-partição gera contents.partN.json do zero e rmSync o contents.json
  //    antigo) — por isso o sinal é o status PORCELAIN do dir inteiro: qualquer entrada que não
  //    seja só meta/corpus modificados = dado novo (parte nova, articles mudado, arquivo
  //    removido). O que sobra em meta/corpus (o bump do generatedAt) é tratado em seguida.
  const dataStatus = (run(['status', '--porcelain', '--', DATA_REL, API_REL], { allowFail: true }) || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // " M path" / "?? path" / " D path" → o caminho começa após 2 chars de status + espaço.
  const changedPaths = dataStatus
    .map((l) => l.replace(/^..?\s/, '').replace(/^"|"$/g, ''))
    .filter((f) => f !== META_REL && f !== CORPUS_REL);
  let dataChanged = changedPaths.length > 0;
  if (!dataChanged) dataChanged = VOLATILE_REL.some((rel) => changedIgnoringVolatile(run, rel));

  // 6. Decisão. A referência é o snapshot do HEAD (`localStamp`, lido no passo 3), NÃO o da árvore
  // de trabalho: o export acabou de bumpar o generatedAt ali, então comparar com ele daria "site
  // atrasado" em toda run — republicação infinita.
  const codeChanged = includeCode && dirty.code.length > 0;
  const plan = planDeploy({ dataChanged, codeChanged, ahead, live, localStamp, force });

  if (!plan.publish) {
    // Deixa a árvore como estava: o export reescreveu o snapshot sem nada a publicar.
    restoreSnapshot(run);
    log(`snapshot já em dia (${web.articles ?? localStamp?.articles ?? '?'} artigos) — nada a publicar.`);
    log('dica: `ncrawl deploy --force` republica de qualquer forma (força um build novo na Vercel).');
    return { status: 'up-to-date', reason: plan.reason, live, articles: web.articles, ahead };
  }

  const alvo = {
    reason: plan.reason,
    articles: web.articles,
    bytes: (web.bytes || 0) + (api.bytes || 0),
    commit: dataChanged || plan.refresh,
    code: includeCode ? dirty.code : [],
    ahead,
  };

  if (dryRun) {
    log('--dry-run: nada foi commitado nem pushado. Plano:');
    log(`  motivo: ${MOTIVO[plan.reason] || plan.reason}`);
    log(`  commit: ${alvo.commit ? `${DATA_REL} + ${API_REL}${alvo.code.length ? ` + ${alvo.code.length} arquivo(s) de código` : ''}` : '(nada — só push)'}`);
    log(`  push:   origin ${branch}${ahead ? ` (${ahead} commit(s) local(is) pendente(s))` : ''}`);
    log(`  espera: ${noWait ? 'não (--no-wait)' : `até ${fmtElapsed(waitMs)} pelo site no ar`}`);
    // Sem dado novo, um --dry-run não deixa rastro (o export só bumpou o generatedAt).
    if (!dataChanged) restoreSnapshot(run);
    return { status: 'dry-run', ...alvo };
  }

  // 7. Commit. `plan.refresh` (force/site atrasado) publica o snapshot recém-gerado: o generatedAt
  //    novo é justamente o que faz a Vercel ver dado novo e o polling ter um alvo verificável.
  if (alvo.commit) {
    const paths = [DATA_REL, API_REL, ...alvo.code];
    const assunto =
      plan.reason === 'code'
        ? 'chore(deploy): publica código do webapp + snapshot'
        : `chore(data): atualiza snapshot do webapp + API pública${dataChanged ? '' : ' (republicação)'}`;
    const msg =
      `${assunto}\n\n${web.articles} artigos` +
      `${alvo.code.length ? ` + ${alvo.code.length} arquivo(s) de código` : ''}` +
      ` — publicado por \`ncrawl deploy\` (motivo: ${plan.reason}).`;
    run(['add', '--', ...paths]);
    run(['commit', '--no-verify', '-m', msg, '--', ...paths]);
    log(`commit criado: ${run(['rev-parse', '--short', 'HEAD'])} — ${web.articles} artigos.`);
  } else {
    // Só push: o export reescreveu o snapshot na árvore sem nada a publicar — limpa o ruído.
    restoreSnapshot(run);
    log(`nada novo a commitar; publicando ${ahead} commit(s) local(is) pendente(s).`);
  }

  // 8. Push. --no-verify: o hook pre-push refaria ESTE MESMO export e abortaria o push (por design
  //    dele, p/ o commit novo não ficar de fora) — aqui o snapshot já está commitado.
  log(`enviando para origin/${branch}…`);
  try {
    run(['push', '--no-verify', 'origin', `HEAD:refs/heads/${branch}`]);
  } catch (e) {
    // Falha de AUTENTICAÇÃO é a causa nº1 do deploy no menu: dá hint acionável em vez do erro cru.
    const msg = String(e?.message || e);
    if (/(Invalid username or token|Password authentication|Authentication failed|Could not read|could not read Username|401|403|auth)/i.test(msg)) {
      throw new DeployError(
        'o push falhou por AUTENTICAÇÃO do GitHub — o deploy não consegue publicar sem credencial válida.',
        'rode `gh auth login` (confirma github.com, protocolo https) e tente de novo; ou use um PAT de escopo repo: `git remote set-url origin https://<USUARIO>:<PAT>@github.com/…git`. É esperado: o GitHub não aceita senha de conta para push.',
      );
    }
    throw e;
  }
  const sha = run(['rev-parse', 'HEAD']);
  log(`push concluído ✓ commit ${sha.slice(0, 7)} na ${branch}.`);

  // 9. O alvo do polling é o generatedAt DO HEAD (o que a Vercel vai construir) — não o da árvore
  //     de trabalho, que pode ter sido bumpado sem commit.
  const headStamp = readSnapshotStamp(showHead(run, META_REL));
  if (noWait) {
    log(`--no-wait: a Vercel publica em ~1-2min. Confira: ${SITE_URL}`);
    return { status: 'pushed', sha, url: SITE_URL, articles: web.articles, expected: headStamp?.generatedAt || null, reason: plan.reason };
  }
  if (!headStamp) {
    warn('não deu para ler o generatedAt do HEAD — pulando a confirmação.');
    return { status: 'pushed', sha, url: SITE_URL, articles: web.articles, expected: null, reason: plan.reason };
  }

  const res = await waitForPublish(headStamp.generatedAt, { waitMs, pollMs: DEPLOY_POLL_MS });
  if (res.ok) {
    log(`deploy no ar ✓ ${SITE_URL} — ${res.live.articles ?? web.articles} artigos em ${fmtElapsed(res.elapsedMs)}.`);
    return {
      status: 'live', sha, url: SITE_URL, articles: res.live.articles ?? web.articles,
      elapsedMs: res.elapsedMs, expected: headStamp.generatedAt, reason: plan.reason,
    };
  }
  return {
    status: 'timeout', sha, url: SITE_URL, articles: web.articles, elapsedMs: res.elapsedMs,
    expected: headStamp.generatedAt, live: res.live, reason: plan.reason,
  };
}

const MOTIVO = {
  force: 'republicação forçada (--force)',
  data: 'dados novos no snapshot',
  code: 'código não commitado do repo (--include-code)',
  unpushed: 'commits locais ainda não publicados',
  'site-behind': 'o site no ar está atrasado em relação ao snapshot local',
};

/**
 * Devolve a árvore de trabalho ao estado do HEAD quando o deploy não vai publicar o que exportou
 * (nada a fazer, --dry-run, remoto à frente, ou o guard anti-encolhimento bloqueando).
 *
 * Restaura os DIRETÓRIOS INTEIROS — a mesma política do hook (`git restore -- "$DATA_DIR"
 * "$API_DIR"`) — e não só os dois arquivos voláteis. A versão antiga (`restoreVolatile`, só
 * meta.json + corpus.json) tinha um buraco de verdade: o export reescreve TAMBÉM `articles.json` e
 * os `contents.partN.json`, então todo abandono depois do export deixava esses arquivos já
 * ESVAZIADOS na árvore — o dado saía pela porta dos fundos no `git add` seguinte, com o guard
 * "funcionando".
 *
 * A remoção fecha o outro lado: `restore`/`checkout` não removem arquivo NOVO não-rastreado, e o
 * export cria partes conforme o acervo cresce. Sem ela, um bloqueio deixaria partes órfãs na
 * árvore (git status sujo, prontas p/ o próximo add) — ver `cleanExportOrphans`.
 */
export function restoreSnapshot(run = git) {
  if (run(['restore', '--', ...SNAPSHOT_REL], { allowFail: true }) === null) {
    run(['checkout', '--', ...SNAPSHOT_REL], { allowFail: true });
  }
  return cleanExportOrphans(run);
}

/**
 * Remove da árvore os ÓRFÃOS DO EXPORT: os arquivos que o export acabou de criar e que o `restore`
 * não desfaz por serem não-rastreados (tipicamente uma `contents.partN.json` nova). Devolve a lista
 * removida — e a DIZ em log, porque sumiço silencioso de arquivo não existe neste módulo.
 *
 * Escopo por NOME (`isExportArtifact`), nunca por diretório. Aqui morava um
 * `git clean -fdq -- <dirs>`, que varria os dois diretórios INTEIROS: qualquer arquivo do usuário
 * guardado ali (um `ANOTACOES.md`, um `backup-manual/` — e com `-d` o diretório inteiro) sumia
 * junto, em silêncio (`-q`) e sem volta, num módulo cujo propósito é justamente não perder dado. O
 * deploy é dono do que o export escreve; do resto que estiver na pasta, não.
 */
function cleanExportOrphans(run) {
  // `ls-files --others` só lista NÃO-RASTREADOS; `--exclude-standard` respeita o .gitignore do
  // usuário (o `clean` sem -x fazia o mesmo). Nada rastreado pode ser tocado por aqui.
  const listed = run(['ls-files', '--others', '--exclude-standard', '--', ...SNAPSHOT_REL], { allowFail: true });
  const orfaos = String(listed || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && isExportArtifact(l));
  if (!orfaos.length) return [];
  // Caminhos EXATOS (nunca um diretório): `-f` sem `-d` não remove pasta nem por acidente.
  run(['clean', '-f', '--', ...orfaos], { allowFail: true });
  log(`árvore restaurada: ${orfaos.length} arquivo(s) novo(s) do export removido(s) — ${orfaos.join(', ')}.`);
  return orfaos;
}
