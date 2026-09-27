#!/usr/bin/env node
// Guarda de GASTO do desenvolvimento (feat/jev, teto US$ 2). Mede o gasto REAL pela chave da
// OpenRouter (GET /api/v1/key → `usage`, acumulado da vida da chave; a consulta é GRÁTIS) contra
// uma BASE gravada em NC_HOME/dev-spend.json, e barra/derruba etapas pagas antes de passarem da
// GUARDA (80% do teto: o /key atrasa de segundos a minutos em relação ao gasto real, e a margem
// cobre esse atraso). É a trava SUAVE — a única trava DURA é uma chave dedicada com limite de
// crédito no servidor (402 ao esgotar).
//
//   node scripts/dev-spend.mjs baseline [--value N] [--cap 2] [--guard 1.6] [--force]
//   node scripts/dev-spend.mjs check --need X
//   node scripts/dev-spend.mjs run --need X [--poll-ms 15000] -- <cmd...>
//   node scripts/dev-spend.mjs report [--offline]
//
// Códigos de saída: 0 ok · 1 uso errado · 2 gasto DESCONHECIDO (sem base, /key ilegível, chave
// trocada — fail-SAFE: não roda nada, ao contrário do resto do projeto) · 3 passaria da guarda
// (no `run`: a guarda DERRUBOU o filho). A chave nunca é impressa (só o label mascarado).
//
// Sem efeito colateral ao importar: o teste importa os helpers PUROS (decide/pollAction/
// formatReport/...). keys.js → config.js (que cria o NC_HOME e carrega os .env) só entra por
// import DINÂMICO dentro do main — e DEPOIS de fotografar o env do shell (ver envPins).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { log, warn, errorLog, sleep } from '../src/util.js';
import { redactSecrets } from '../src/redact.js';

// ---- defaults (todos com override por env; flags vencem o env) ----
export const DEFAULT_CAP_USD = 2;
export const GUARD_RATIO = 0.8;
export const DEFAULT_POLL_MS = 15000;
// SIGTERM → espera isto → SIGKILL (o crawler fecha o Chromium e dá flush no ledger no SIGTERM).
export const DEFAULT_KILL_GRACE_MS = 10000;
// Após o filho sair, espera antes da leitura final: o /key atrasa, e o `after` cedo demais
// subnotificaria o delta da execução.
export const DEFAULT_SETTLE_MS = 5000;
// Leituras seguidas sem conseguir medir (rede fora, 5xx, chave trocada) antes de derrubar o
// filho: 8 × 15s = 2 min correndo às cegas é o máximo tolerado (fail-safe).
export const DEFAULT_MAX_BLIND = 8;

const EPS = 1e-9;

/** Arredonda p/ 8 casas (a OpenRouter reporta usage com 8 casas; evita ruído de ponto flutuante). */
export const round8 = (n) => Math.round(Number(n) * 1e8) / 1e8;

/** Número finito ou null — null é "desconhecido", nunca zero. */
export function num(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---- argv ----
const BOOL_FLAGS = new Set(['force', 'offline', 'help']);

/**
 * `<sub> [--k v | --k=v | --flag] [-- <cmd...>]`. Tudo depois do PRIMEIRO `--` é o comando do
 * filho, intacto (as flags dele não são interpretadas aqui).
 */
export function parseArgv(argv) {
  const cut = argv.indexOf('--');
  const own = cut >= 0 ? argv.slice(0, cut) : argv.slice();
  const cmd = cut >= 0 ? argv.slice(cut + 1) : [];
  const flags = {};
  const positional = [];
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = (eq >= 0 ? a.slice(2, eq) : a.slice(2)).trim();
      if (eq >= 0) flags[k] = a.slice(eq + 1);
      else if (BOOL_FLAGS.has(k)) flags[k] = true;
      else if (i + 1 < own.length && !own[i + 1].startsWith('--')) flags[k] = own[++i];
      else flags[k] = true;
    } else {
      positional.push(a);
    }
  }
  return { sub: positional[0] || null, positional: positional.slice(1), flags, cmd };
}

// ---- decisão (pura) ----

/**
 * Cabe gastar `need` sem passar da guarda? Tudo em USD. Desconhecido (sem base, uso ilegível,
 * chave trocada) volta `{ ok:false, unknown:true, reason }` — o chamador NÃO roda (fail-safe).
 * `ok` exige também sobra > 0: BUDGET_USD=0 no filho significaria orçamento ILIMITADO no ledger.
 */
export function decide({ baseline, guard, usage, need = 0, keyLabel = null, label = null }) {
  const b = num(baseline);
  const g = num(guard);
  const u = num(usage);
  const n = num(need);
  const unknown = (reason) => ({
    ok: false, unknown: true, reason, spent: null, remaining: null, need: n, guard: g, projected: null,
  });
  if (b == null) return unknown('sem base: rode `node scripts/dev-spend.mjs baseline` primeiro');
  if (g == null || g <= 0) return unknown('guarda inválida no dev-spend.json');
  if (n == null || n < 0) return unknown('need inválido (USD >= 0)');
  if (u == null) return unknown('uso da chave ilegível (GET /api/v1/key)');
  // Label diferente do gravado na base = OUTRA chave: o delta contra a base não significa nada.
  if (keyLabel && label && keyLabel !== label) {
    return unknown(`chave diferente da base (${label} ≠ ${keyLabel}): rode \`baseline --force\` com a chave nova`);
  }
  // Uso abaixo da base também denuncia chave trocada (o acumulado da chave nunca diminui) — sem
  // este corte o "gasto" ficaria NEGATIVO e a guarda nunca dispararia.
  if (u < b - EPS) return unknown('uso da chave abaixo da base (chave trocada?): rode `baseline --force`');
  const spent = round8(u - b);
  const remaining = round8(g - spent);
  const projected = round8(spent + n);
  return { ok: projected <= g + EPS && remaining > EPS, unknown: false, reason: null, spent, remaining, need: n, guard: g, projected };
}

/**
 * Orçamento do filho (env BUDGET_USD): o MENOR entre o `need` da etapa e a sobra até a guarda,
 * truncado p/ 6 casas e com piso de 1e-6 — "0" no config.js significa ILIMITADO, então nunca pode
 * sair zero daqui. O need (e não a sobra inteira): um filho sem --budget/--max-usd próprio teria a
 * guarda INTEIRA (~US$ 1,60) como teto, e uma etapa descontrolada gastaria todo o resto do dev antes
 * do próximo poll do /key. need ausente/ilegível → a sobra (o decide já recusa need inválido).
 */
export function childBudget(decision) {
  const r = num(decision?.remaining);
  if (r == null || r <= 0) return null;
  const n = num(decision?.need);
  const cap = n != null && n >= 0 ? Math.min(n, r) : r;
  return Math.max(1e-6, Math.floor(cap * 1e6) / 1e6).toFixed(6);
}

/**
 * Uma leitura durante o `run`: derrubar o filho? `kill` quando o gasto desde a base PASSA da
 * guarda, ou quando a medição falhou `maxBlind` vezes seguidas (correr às cegas é o risco que a
 * guarda existe p/ evitar). `overNeed` só avisa: o teto POR ETAPA é do próprio filho
 * (--max-usd/--budget); a guarda aqui é a global.
 */
export function pollAction({
  baseline, guard, usage, need = 0, before = null, keyLabel = null, label = null,
  blind = 0, maxBlind = DEFAULT_MAX_BLIND,
}) {
  const d = decide({ baseline, guard, usage, need: 0, keyLabel, label });
  if (d.unknown) {
    const nextBlind = blind + 1;
    const cego = nextBlind >= maxBlind;
    return { action: cego ? 'kill' : 'continue', reason: cego ? 'blind' : null, blind: nextBlind, spent: null, stepDelta: null, overNeed: false, detail: d.reason };
  }
  const overGuard = d.spent > d.guard + EPS;
  const b = num(before);
  const stepDelta = b == null ? null : round8(num(usage) - b);
  const n = num(need) ?? 0;
  return {
    action: overGuard ? 'kill' : 'continue',
    reason: overGuard ? 'guard' : null,
    blind: 0,
    spent: d.spent,
    stepDelta,
    overNeed: stepDelta != null && stepDelta > n + EPS,
    detail: null,
  };
}

/** Código de saída do `run`: 3 se a guarda derrubou; senão o do filho (sinal → 128+n; spawn falhou → 127). */
export function exitCodeFor({ killedBy = null, code = null, signal = null, spawnError = null }) {
  if (killedBy) return 3;
  if (spawnError) return 127;
  if (code != null) return code;
  if (signal) return 128 + (osConstants.signals[signal] || 0);
  return 1;
}

// O comando vai p/ o histórico em disco: redige com o src/redact.js (que já casa a chave da
// OpenRouter, `sk-or-v<n>-` + 20+ alfanuméricos) e, POR CIMA, um corte mais largo só p/ linha de
// comando: `sk-or-v<n>-` + 8+ de [A-Za-z0-9_-]. A diferença é de propósito — no redact.js um falso
// positivo CORROMPE o corpo de um artigo exportado (por isso ele exige 20+ e deixa um
// `sk-or-v1-placeholder` em paz); aqui redigir demais num log de comando não custa nada.
export function redactCmd(argv) {
  const txt = (Array.isArray(argv) ? argv : [argv])
    .map((a) => (/^[\w@%+=:,./-]+$/.test(String(a)) ? String(a) : JSON.stringify(String(a))))
    .join(' ');
  return redactSecrets(txt).replace(/sk-or-v\d+-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
}

/** Registro de uma execução (`before`/`after` = usage BRUTO da chave, auditável no painel). */
export function makeRecord({ cmd, need, before, after, code = null, signal = null, killedBy = null, startedAt = null, now = new Date() }) {
  const b = num(before);
  const a = num(after);
  const t0 = startedAt ? new Date(startedAt).getTime() : null;
  return {
    cmd: redactCmd(cmd),
    need: num(need),
    before: b,
    after: a,
    delta: b != null && a != null ? round8(a - b) : null,
    at: now.toISOString(),
    code,
    signal,
    killedBy,
    ms: t0 != null ? Math.max(0, now.getTime() - t0) : null,
  };
}

/**
 * Onde o filho NÃO herdaria o nosso env: o config.js RECARREGA os .env (repo e NC_HOME) em cima
 * do env do processo (o .env vence o shell — regra do projeto). Se um .env fixa LLM_PROVIDER ou
 * BUDGET_USD, o LLM_PROVIDER=openrouter / BUDGET_USD que passamos ao filho é SOBRESCRITO lá
 * dentro. Detecção sem ler arquivo: compara o env fotografado ANTES de importar o config com o
 * env DEPOIS (o import aplicou os .env em process.env). `fromDotEnv` = certeza (o valor mudou no
 * import); `uncertain` = mesmo valor antes e depois (shell sozinho, ou shell E .env iguais).
 */
export function envPins(shellEnv, loadedEnv) {
  const pin = (k) => {
    const before = shellEnv?.[k];
    const after = loadedEnv?.[k];
    return {
      value: after ?? null,
      fromDotEnv: after !== undefined && after !== before,
      uncertain: after !== undefined && after === before,
    };
  };
  const provider = pin('LLM_PROVIDER');
  const budget = pin('BUDGET_USD');
  return {
    provider,
    budget,
    // DeepSeek DIRETO gasta FORA da chave medida (a guarda ficaria cega). Bloqueia mesmo no caso
    // incerto: não dá p/ provar que o valor não vem de um .env que o filho vai reaplicar.
    providerBlocks: String(provider.value || '').trim().toLowerCase() === 'deepseek',
  };
}

// ---- estado em disco ----

/** Lê o dev-spend.json. Ausente → { state:null }; corrompido → { state:null, error } (o chamador trata como desconhecido). */
export function loadState(file) {
  if (!existsSync(file)) return { state: null, error: null };
  try {
    const st = JSON.parse(readFileSync(file, 'utf8'));
    if (!st || typeof st !== 'object') return { state: null, error: 'dev-spend.json não é um objeto' };
    if (!Array.isArray(st.history)) st.history = [];
    return { state: st, error: null };
  } catch (e) {
    return { state: null, error: `dev-spend.json ilegível: ${e.message}` };
  }
}

/** Grava atômico (tmp + rename): um Ctrl+C no meio não deixa o arquivo pela metade. */
export function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, file);
}

/** Anexa um registro RELENDO o arquivo (outra execução pode ter gravado no meio tempo). */
export function appendHistory(file, record) {
  const { state, error } = loadState(file);
  if (!state) throw new Error(error || 'dev-spend.json sumiu durante a execução');
  state.history.push(record);
  saveState(file, state);
  return state;
}

// ---- relatório (puro) ----
const usd8 = (v) => (num(v) == null ? 'n/d' : num(v).toFixed(8));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

/** Tabela do histórico + total. `usage` (opcional) = leitura AO VIVO, p/ mostrar o gasto fora do dev-spend. */
export function formatReport(state, { usage = null } = {}) {
  if (!state) return 'dev-spend: sem base (rode `node scripts/dev-spend.mjs baseline`).';
  const hist = Array.isArray(state.history) ? state.history : [];
  const lines = [];
  lines.push(
    `dev-spend · base US$ ${usd8(state.baseline)} (${state.createdAt || '?'}${state.source ? `, ${state.source}` : ''})` +
      ` · teto US$ ${(num(state.cap) ?? 0).toFixed(2)} · guarda US$ ${(num(state.guard) ?? 0).toFixed(2)}`,
  );
  if (!hist.length) {
    lines.push('(nenhuma execução registrada)');
  } else {
    lines.push(`${lpad('#', 3)}  ${pad('quando (UTC)', 16)}  ${lpad('Δ US$', 11)}  ${lpad('need', 7)}  ${pad('saída', 10)}  comando`);
    hist.forEach((r, i) => {
      const quando = String(r.at || '').replace('T', ' ').slice(0, 16);
      const saida = r.killedBy ? `morto:${r.killedBy}` : r.signal ? String(r.signal) : String(r.code ?? '?');
      const cmd = String(r.cmd || '');
      lines.push(
        `${lpad(i + 1, 3)}  ${pad(quando, 16)}  ${lpad(usd8(r.delta), 11)}  ${lpad(num(r.need) == null ? 'n/d' : num(r.need).toFixed(4), 7)}  ${pad(saida, 10)}  ${cmd.length > 90 ? `${cmd.slice(0, 89)}…` : cmd}`,
      );
    });
  }
  const medidos = hist.filter((r) => num(r.delta) != null);
  const total = round8(medidos.reduce((s, r) => s + num(r.delta), 0));
  const semMedida = hist.length - medidos.length;
  lines.push(`total registrado: US$ ${usd8(total)} em ${hist.length} execução(ões)${semMedida ? ` (${semMedida} sem medição)` : ''}`);
  const d = decide({ baseline: state.baseline, guard: state.guard, usage, need: 0 });
  if (!d.unknown) {
    // Gasto na chave que NÃO passou pelo `run` (smokes manuais, o atraso do /key, outro uso da chave).
    const fora = round8(d.spent - total);
    lines.push(
      `gasto na chave desde a base: US$ ${usd8(d.spent)} (fora do dev-spend run: US$ ${usd8(fora)}) · resta até a guarda: US$ ${usd8(d.remaining)}`,
    );
  } else if (usage != null) {
    lines.push(`gasto ao vivo: desconhecido — ${d.reason}`);
  }
  return lines.join('\n');
}

// ---- execução vigiada ----

/**
 * `run`: confere a guarda, sobe o filho com BUDGET_USD=min(need, sobra) e LLM_PROVIDER=openrouter, lê o
 * uso a cada `pollMs` e manda SIGTERM (depois SIGKILL) se o gasto passar da guarda; na saída
 * anexa {cmd, need, before, after, delta, at, ...} ao histórico. Tudo injetável p/ teste
 * (readUsage/spawnFn/tempos) — a leitura real é o getKeyUsage do keys.js.
 * Retorna { exit, started, decision, record }.
 */
export async function runGuarded({
  cmd,
  need,
  file,
  readUsage,
  env = process.env,
  pollMs = DEFAULT_POLL_MS,
  graceMs = DEFAULT_KILL_GRACE_MS,
  settleMs = DEFAULT_SETTLE_MS,
  maxBlind = DEFAULT_MAX_BLIND,
  spawnFn = spawn,
  stdio = 'inherit',
  forwardSignals = false,
  childEnv = {},
  report = { info: log, warn, error: errorLog },
}) {
  if (!Array.isArray(cmd) || !cmd.length) throw new Error('run: faltou o comando depois de `--`');
  const { state, error } = loadState(file);
  if (!state) {
    const decision = decide({ baseline: null, guard: null, usage: null, need });
    if (error) decision.reason = error;
    return { exit: 2, started: false, decision, record: null };
  }
  // Leitura injetada nunca derruba o run: exceção vira "ilegível" (o decide trata como desconhecido).
  const safeRead = () => Promise.resolve()
    .then(readUsage)
    .catch((e) => ({ ok: false, status: 0, reason: e?.message || String(e), usage: null, label: null }));
  const first = await safeRead();
  const decision = decide({
    baseline: state.baseline, guard: state.guard, usage: first?.usage, need, keyLabel: state.keyLabel, label: first?.label,
  });
  if (decision.unknown && first && !first.ok && first.reason) decision.reason += ` — ${first.reason}`;
  if (!decision.ok) return { exit: decision.unknown ? 2 : 3, started: false, decision, record: null };

  const budget = childBudget(decision);
  const before = num(first.usage);
  const startedAt = new Date();
  report.info(
    `dev-spend: gasto US$ ${usd8(decision.spent)} · need US$ ${decision.need} · resta US$ ${usd8(decision.remaining)} até a guarda US$ ${decision.guard} → filho com BUDGET_USD=${budget}`,
  );

  // Grupo de processos PRÓPRIO (POSIX): o sinal da guarda precisa alcançar os NETOS também —
  // `npm run crawl` → sh → node → Chromium; um SIGTERM só no npm deixaria o gasto correndo.
  // Efeito colateral: o Ctrl+C do terminal deixa de chegar direto ao filho — o pai repassa (abaixo).
  const ownGroup = process.platform !== 'win32';
  const child = spawnFn(cmd[0], cmd.slice(1), {
    stdio,
    detached: ownGroup,
    // DEV_SPEND_GUARDED: o harness de eval pode exigir estar sob a guarda. `childEnv` (ex.: a chave
    // MEDIDA) vence o env do shell; as três da guarda vencem tudo.
    env: { ...env, ...childEnv, BUDGET_USD: budget, LLM_PROVIDER: 'openrouter', DEV_SPEND_GUARDED: '1' },
  });
  const signalTree = (sig) => {
    try {
      if (ownGroup && child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      try { child.kill(sig); } catch { /* já saiu */ }
    }
  };

  let exited = false;
  let killedBy = null;
  let blind = 0;
  let inFlight = false;
  let warnedNeed = false;
  let killTimer = null;

  const kill = (reason, detail) => {
    if (exited || killedBy) return;
    killedBy = reason;
    report.error(`dev-spend: DERRUBANDO o filho (${reason}${detail ? `: ${detail}` : ''}) — SIGTERM, SIGKILL em ${graceMs}ms`);
    signalTree('SIGTERM');
    killTimer = setTimeout(() => {
      if (!exited) signalTree('SIGKILL');
    }, graceMs);
    killTimer.unref?.();
  };

  const poll = async () => {
    if (inFlight || exited || killedBy) return;
    inFlight = true;
    try {
      const r = await safeRead();
      if (exited) return;
      const a = pollAction({
        baseline: state.baseline, guard: state.guard, usage: r?.usage, need: decision.need, before,
        keyLabel: state.keyLabel, label: r?.label, blind, maxBlind,
      });
      blind = a.blind;
      if (a.detail) report.warn(`dev-spend: leitura ${blind}/${maxBlind} sem medir — ${a.detail}${r?.reason ? ` (${r.reason})` : ''}`);
      if (a.overNeed && !warnedNeed) {
        warnedNeed = true;
        report.warn(`dev-spend: esta execução já gastou US$ ${usd8(a.stepDelta)} > need US$ ${decision.need} (o teto da ETAPA é do filho: --max-usd/--budget)`);
      }
      if (a.action === 'kill') kill(a.reason, a.reason === 'guard' ? `gasto US$ ${usd8(a.spent)} > guarda US$ ${state.guard}` : a.detail);
    } catch (e) {
      report.warn(`dev-spend: leitura falhou — ${e.message}`);
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(poll, pollMs);

  // Ctrl+C/SIGTERM/SIGHUP no PAI são repassados ao grupo do filho (que não recebe mais o sinal do
  // terminal) — e o pai sobrevive p/ fazer a leitura final e gravar o registro.
  const FWD = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const onFwd = (sig) => signalTree(sig);
  if (forwardSignals) for (const sig of FWD) process.on(sig, onFwd);

  const { code, signal, spawnError } = await new Promise((resolve) => {
    child.once('error', (e) => resolve({ code: null, signal: null, spawnError: e }));
    child.once('exit', (c, s) => resolve({ code: c, signal: s, spawnError: null }));
  });
  exited = true;
  clearInterval(timer);
  if (killTimer) clearTimeout(killTimer);
  if (forwardSignals) for (const sig of FWD) process.off(sig, onFwd);
  if (spawnError) report.error(`dev-spend: não consegui iniciar \`${cmd[0]}\` — ${spawnError.message}`);

  if (settleMs > 0 && !spawnError) await sleep(settleMs);
  const last = spawnError ? first : await safeRead();
  const record = makeRecord({
    cmd, need: decision.need, before, after: last?.usage, code, signal, killedBy, startedAt,
  });
  try {
    appendHistory(file, record);
  } catch (e) {
    report.error(`dev-spend: não gravei o histórico — ${e.message}`);
  }
  const after = decide({ baseline: state.baseline, guard: state.guard, usage: last?.usage, need: 0 });
  report.info(
    `dev-spend: Δ desta execução US$ ${usd8(record.delta)} · gasto desde a base US$ ${usd8(after.spent)} · resta até a guarda US$ ${usd8(after.remaining)}`,
  );
  return { exit: exitCodeFor({ killedBy, code, signal, spawnError }), started: true, decision, record };
}

// ---- CLI ----
const out = (s) => process.stdout.write(`${s}\n`);

const HELP = `uso:
  node scripts/dev-spend.mjs baseline [--value N] [--cap 2] [--guard 1.6] [--force]
  node scripts/dev-spend.mjs check --need X
  node scripts/dev-spend.mjs run --need X [--poll-ms 15000] -- <cmd...>
  node scripts/dev-spend.mjs report [--offline]
saída: 0 ok · 1 uso errado · 2 gasto desconhecido · 3 passaria/passou da guarda`;

function envNum(name, dflt) {
  return num(process.env[name]) ?? dflt;
}

async function main(argv) {
  const { sub, flags, cmd } = parseArgv(argv);
  if (!sub || flags.help || sub === 'help') {
    out(HELP);
    return sub ? 0 : 1;
  }
  // Foto do env do SHELL antes do config.js aplicar os .env (ver envPins).
  const shellEnv = { ...process.env };
  const { getKeyUsage } = await import('../src/keys.js');
  const cfg = await import('../src/config.js');
  const { NC_HOME } = cfg;
  const file = process.env.DEV_SPEND_FILE ? path.resolve(process.env.DEV_SPEND_FILE) : path.join(NC_HOME, 'dev-spend.json');
  const timeoutMs = envNum('DEV_SPEND_TIMEOUT_MS', 15000);
  // `undefined` → default do getKeyUsage = OPENROUTER_API_KEY (live binding). Nunca a imprimimos.
  const readUsage = () => getKeyUsage(undefined, { timeoutMs });

  if (sub === 'baseline') {
    const { state: prev, error } = loadState(file);
    if (error && !flags.force) {
      errorLog(`dev-spend: ${error} — conserte o arquivo ou use --force (${file})`);
      return 2;
    }
    if (prev && num(prev.baseline) != null && !flags.force) {
      errorLog(`dev-spend: já existe base US$ ${usd8(prev.baseline)} (${prev.createdAt}) em ${file}; --force p/ regravar (o histórico é preservado)`);
      return 1;
    }
    const cap = num(flags.cap) ?? envNum('DEV_SPEND_CAP_USD', DEFAULT_CAP_USD);
    const guard = num(flags.guard) ?? envNum('DEV_SPEND_GUARD_USD', round8(cap * GUARD_RATIO));
    if (!(cap > 0) || !(guard > 0) || guard > cap) {
      errorLog('dev-spend: --cap/--guard inválidos (0 < guarda <= teto)');
      return 1;
    }
    const r = await readUsage();
    const manual = flags.value !== undefined;
    const value = manual ? num(flags.value) : num(r.usage);
    if (manual && (value == null || value < 0)) {
      errorLog('dev-spend: --value precisa ser um número >= 0 (USD)');
      return 1;
    }
    if (value == null) {
      errorLog(`dev-spend: não li o uso da chave (${r.reason || 'sem resposta'}) — sem base; tente de novo ou passe --value N`);
      return 2;
    }
    const state = {
      baseline: value,
      cap,
      guard,
      createdAt: new Date().toISOString(),
      source: manual ? 'manual' : 'probe',
      keyLabel: r.ok ? r.label : null,
      history: prev?.history || [],
      previous: [
        ...(Array.isArray(prev?.previous) ? prev.previous : []),
        ...(prev && num(prev.baseline) != null ? [{ baseline: prev.baseline, createdAt: prev.createdAt, source: prev.source || null }] : []),
      ],
    };
    saveState(file, state);
    const d = decide({ baseline: value, guard, usage: r.usage, need: 0, keyLabel: state.keyLabel, label: r.label });
    out(JSON.stringify({
      file, baseline: value, cap, guard, source: state.source, usage: num(r.usage) == null ? null : round8(r.usage), limit: r.limit,
      limit_remaining: r.limit_remaining, label: r.label, spent: d.spent, remaining: d.remaining,
    }));
    return 0;
  }

  if (sub === 'check') {
    const need = flags.need === undefined ? 0 : num(flags.need);
    if (need == null || need < 0) {
      errorLog('dev-spend: --need precisa ser um número >= 0 (USD)');
      return 1;
    }
    const { state, error } = loadState(file);
    const r = state ? await readUsage() : null;
    const d = decide({
      baseline: state?.baseline, guard: state?.guard, usage: r?.usage, need, keyLabel: state?.keyLabel, label: r?.label,
    });
    if (error) d.reason = error;
    else if (d.unknown && r && !r.ok && r.reason) d.reason += ` — ${r.reason}`;
    out(JSON.stringify({
      ok: d.ok, spent: d.spent, remaining: d.remaining, need: d.need, projected: d.projected, guard: d.guard,
      cap: num(state?.cap), usage: num(r?.usage) == null ? null : round8(r.usage), limit_remaining: r?.limit_remaining ?? null,
      label: r?.label ?? null, ...(d.reason ? { reason: d.reason } : {}),
    }));
    return d.ok ? 0 : d.unknown ? 2 : 3;
  }

  if (sub === 'run') {
    const need = num(flags.need);
    if (need == null || need < 0) {
      errorLog('dev-spend: `run` exige --need <USD> (o teto estimado da etapa)');
      return 1;
    }
    if (!cmd.length) {
      errorLog('dev-spend: faltou o comando: run --need X -- <cmd...>');
      return 1;
    }
    const pins = envPins(shellEnv, process.env);
    if (pins.providerBlocks) {
      errorLog('dev-spend: LLM_PROVIDER=deepseek no ambiente/.env — se vier de um .env (repo ou NC_HOME), o config.js do filho sobrescreve o LLM_PROVIDER=openrouter e o gasto sai FORA da chave medida. Tire a linha (ou o export do shell) e rode de novo.');
      return 2;
    }
    if (pins.budget.fromDotEnv || pins.budget.uncertain) {
      warn(`dev-spend: BUDGET_USD=${pins.budget.value} ${pins.budget.fromDotEnv ? 'vem de um .env e VENCE' : 'está no ambiente; se também estiver num .env, vence'} o BUDGET_USD da guarda dentro do filho (precedência do config.js) — passe --budget/--max-usd no comando; a guarda por leitura do /key segue valendo.`);
    }
    const res = await runGuarded({
      cmd,
      need,
      file,
      readUsage,
      env: shellEnv,
      pollMs: num(flags['poll-ms']) ?? envNum('DEV_SPEND_POLL_MS', DEFAULT_POLL_MS),
      graceMs: envNum('DEV_SPEND_KILL_GRACE_MS', DEFAULT_KILL_GRACE_MS),
      settleMs: envNum('DEV_SPEND_SETTLE_MS', DEFAULT_SETTLE_MS),
      maxBlind: envNum('DEV_SPEND_MAX_BLIND', DEFAULT_MAX_BLIND),
      forwardSignals: true,
      // A chave MEDIDA (a resolvida pelo config.js: o NC_HOME/.env vence o shell) vai ao filho. O
      // shellEnv é a foto de ANTES do config, com a chave do SHELL — um filho que não importa o
      // config.js (script node, curl, prompt-builder) gastaria com ela, FORA do que o /key mede.
      // Lida do binding na hora (nunca impressa).
      childEnv: cfg.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: cfg.OPENROUTER_API_KEY } : {},
    });
    if (!res.started) {
      const d = res.decision;
      errorLog(
        d.unknown
          ? `dev-spend: NÃO rodei — gasto desconhecido: ${d.reason}`
          : `dev-spend: NÃO rodei — gasto US$ ${usd8(d.spent)} + need US$ ${d.need} = US$ ${usd8(d.projected)} > guarda US$ ${d.guard}`,
      );
    }
    return res.exit;
  }

  if (sub === 'report') {
    const { state, error } = loadState(file);
    if (error) {
      errorLog(`dev-spend: ${error}`);
      return 2;
    }
    const r = state && !flags.offline ? await readUsage() : null;
    out(formatReport(state, { usage: r?.usage ?? null }));
    return state ? 0 : 2;
  }

  errorLog(`dev-spend: subcomando desconhecido "${sub}"\n${HELP}`);
  return 1;
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => {
      errorLog(`dev-spend: erro inesperado — ${e?.stack || e}`);
      process.exitCode = 1;
    },
  );
}

export { main };
