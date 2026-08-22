// Deploy do site: exporta o snapshot do webapp + a API pública, publica na branch de produção e
// ESPERA a Vercel confirmar a publicação. O "confirmar" é o ponto: a Vercel publica por Git
// integration, então o push é só o GATILHO — a única prova de que o site está no ar sem credencial
// da Vercel é ler o snapshot SERVIDO (SITE_URL + SITE_META_PATH) e ver o `generatedAt` do HEAD
// pós-push aparecer lá. Sem isso, um build quebrado passa por "deploy ✓".
//
// Ordem: preflight (git/branch/remoto) → export → mudança real → ahead/behind → estado do site no
// ar → decisão → commit → push (--no-verify: o hook pre-push faria o MESMO export de novo e
// abortaria o push) → polling até publicar.
//
// Fail-open onde o custo de errar é baixo (fetch/rede/leitura do site), fail-closed onde publicar
// errado é caro (branch errada, remoto à frente, repo sem git): esses ABORTAM antes de tocar no git.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync, readFileSync as fsReadFileSync, writeFileSync as fsWriteFileSync } from 'node:fs';
import got from 'got';
import {
  ROOT, SITE_URL, SITE_META_PATH, DEPLOY_BRANCH, DEPLOY_WAIT_MS, DEPLOY_POLL_MS,
} from './config.js';
import { exportWebSnapshot } from './export-web.js';
import { exportPublicApi } from './export-api.js';
import { log, warn } from './util.js';

// Caminhos (relativos ao repo) que o deploy é dono de commitar.
const DATA_REL = 'webapp/public/data';
const API_REL = 'webapp/public/api/v1';
const META_REL = `${DATA_REL}/meta.json`;
const CORPUS_REL = `${API_REL}/corpus.json`;
// Só estes dois carregam o campo volátil `generatedAt` (o resto do diff é dado de verdade).
const VOLATILE_REL = [META_REL, CORPUS_REL];

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

// Diff vazio (0) = sem mudança. `git diff --quiet` sai 1 quando há diff, então allowFail distingue.
function hasDiffVsHead(paths) {
  return git(['diff', '--quiet', 'HEAD', '--', ...paths], { allowFail: true }) === null;
}

// Conteúdo de um arquivo no HEAD (null se não existe lá — primeiro commit do snapshot).
function showHead(rel) {
  return git(['show', `HEAD:${rel}`], { allowFail: true });
}

// Mudança real num arquivo que carrega o `generatedAt`: ausente no HEAD = mudança; diff vazio =
// igual; senão pergunta ao diff se sobrou algo além do campo volátil.
function changedIgnoringVolatile(rel) {
  if (git(['cat-file', '-e', `HEAD:${rel}`], { allowFail: true }) === null) return true;
  const diff = git(['diff', '-U0', 'HEAD', '--', rel], { allowFail: true });
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

function preflight() {
  const top = git(['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!top) throw new DeployError('isto não é um repositório git — o deploy publica via git push.');

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== DEPLOY_BRANCH) {
    throw new DeployError(
      `o deploy publica a branch "${DEPLOY_BRANCH}", mas você está em "${branch}".`,
      `troque de branch (git switch ${DEPLOY_BRANCH}) ou faça o merge antes — ` +
        'publicar daqui empurraria a main ANTIGA, sem as suas mudanças.',
    );
  }

  const remotes = (git(['remote'], { allowFail: true }) || '').split('\n').filter(Boolean);
  if (!remotes.includes('origin')) {
    throw new DeployError(
      'nenhum remoto "origin" configurado — a Vercel publica a partir do push.',
      'git remote add origin <url-do-repo>',
    );
  }
  const remoteUrl = git(['remote', 'get-url', 'origin'], { allowFail: true });
  for (const h of ensureGithubGitAuth(remoteUrl).hinted) warn(h);
  return { branch, remoteUrl };
}

// Conta os commits só-nossos e só-do-remoto. Precisa de `git fetch`: fail-open (offline → o push
// falha depois com mensagem clara, não vale abortar aqui).
function divergence() {
  const fetched = git(['fetch', '--quiet', 'origin', DEPLOY_BRANCH], { allowFail: true }) !== null;
  if (!fetched) {
    warn('não deu para consultar o origin (offline?) — seguindo com o estado local.');
    return { ahead: 0, behind: 0, known: false };
  }
  const counts = git(['rev-list', '--left-right', '--count', `origin/${DEPLOY_BRANCH}...HEAD`], {
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
 * flags: { force, 'no-wait', 'dry-run', 'include-code', timeout }
 */
export async function runDeploy(flags = {}) {
  const force = flags.force === true || flags.force === 'true';
  const noWait = flags['no-wait'] === true || flags['no-wait'] === 'true';
  const dryRun = flags['dry-run'] === true || flags['dry-run'] === 'true';
  const includeCode = flags['include-code'] === true || flags['include-code'] === 'true';
  const waitMs = Number(flags.timeout) > 0 ? Number(flags.timeout) * 1000 : DEPLOY_WAIT_MS;

  const { branch } = preflight();

  // 1. Código pendente: nunca entra por acidente. Sem --include-code, só avisa.
  const dirty = splitDirtyPaths(git(['status', '--porcelain'], { allowFail: true }) || '');
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

  // 2. Export (é o mesmo que o hook pre-push faz; sempre bate o generatedAt).
  log('exportando o snapshot do webapp a partir do banco local…');
  const web = exportWebSnapshot({ outDir: path.join(ROOT, DATA_REL) });
  const api = exportPublicApi({ outDir: path.join(ROOT, API_REL) });

  // 3. Mudança REAL = dados diferentes do HEAD, ignorando o generatedAt volátil.
  const dataFiles = [`${DATA_REL}/articles.json`, `${DATA_REL}/contents.json`];
  let dataChanged = hasDiffVsHead(dataFiles);
  if (!dataChanged) dataChanged = VOLATILE_REL.some(changedIgnoringVolatile);

  // 4. Divergência com o remoto: remoto à frente = push rejeitado. Aborta ANTES do commit.
  const { ahead, behind } = divergence();
  if (behind > 0) {
    // Só desfaz o bump de generatedAt se NÃO houver dado novo — com dado novo, restaurar o meta
    // deixaria a árvore incoerente (articles.json novo × meta.json velho).
    if (!dataChanged) restoreVolatile();
    throw new DeployError(
      `o origin/${branch} está ${behind} commit(s) à frente — o push seria rejeitado.`,
      `rode "git pull --rebase origin ${branch}" e tente de novo.`,
    );
  }

  // 5. Estado do site NO AR + decisão.
  // Referência = o snapshot do HEAD (o que a main manda o site servir), NÃO o da árvore de
  // trabalho: o export acabou de bumpar o generatedAt ali, então comparar com ele daria "site
  // atrasado" em toda run — republicação infinita.
  const localStamp = readSnapshotStamp(showHead(META_REL));
  const live = await fetchLiveStamp();
  if (live) log(`site no ar: ${live.articles ?? '?'} artigos (${live.generatedAt})`);
  else warn(`não deu para ler ${SITE_URL}${SITE_META_PATH} — sigo sem comparar com o que está no ar.`);

  const codeChanged = includeCode && dirty.code.length > 0;
  const plan = planDeploy({ dataChanged, codeChanged, ahead, live, localStamp, force });

  if (!plan.publish) {
    // Deixa a árvore como estava: o export bumpou o generatedAt de meta/corpus sem nada a publicar.
    restoreVolatile();
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
    if (!dataChanged) restoreVolatile();
    return { status: 'dry-run', ...alvo };
  }

  // 6. Commit. `plan.refresh` (force/site atrasado) publica o snapshot recém-gerado: o generatedAt
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
    git(['add', '--', ...paths]);
    git(['commit', '--no-verify', '-m', msg, '--', ...paths]);
    log(`commit criado: ${git(['rev-parse', '--short', 'HEAD'])} — ${web.articles} artigos.`);
  } else {
    // Só push: o export bumpou meta/corpus na árvore sem nada a publicar neles — limpa o ruído.
    restoreVolatile();
    log(`nada novo a commitar; publicando ${ahead} commit(s) local(is) pendente(s).`);
  }

  // 7. Push. --no-verify: o hook pre-push refaria ESTE MESMO export e abortaria o push (por design
  //    dele, p/ o commit novo não ficar de fora) — aqui o snapshot já está commitado.
  log(`enviando para origin/${branch}…`);
  try {
    git(['push', '--no-verify', 'origin', `HEAD:refs/heads/${branch}`]);
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
  const sha = git(['rev-parse', 'HEAD']);
  log(`push concluído ✓ commit ${sha.slice(0, 7)} na ${branch}.`);

  // 8. O alvo do polling é o generatedAt DO HEAD (o que a Vercel vai construir) — não o da árvore
  //    de trabalho, que pode ter sido bumpado sem commit.
  const headStamp = readSnapshotStamp(showHead(META_REL));
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

// Desfaz o bump de `generatedAt` quando não há nada a publicar (mesma política do hook pre-push):
// o comando não pode deixar ruído na árvore de trabalho.
function restoreVolatile() {
  if (git(['restore', '--', ...VOLATILE_REL], { allowFail: true }) === null) {
    git(['checkout', '--', ...VOLATILE_REL], { allowFail: true });
  }
}
