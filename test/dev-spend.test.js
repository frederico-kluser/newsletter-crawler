// Eval da guarda de gasto do desenvolvimento (scripts/dev-spend.mjs) + keys.getKeyUsage.
// A decisão é testada com leituras de uso INJETADAS (sem rede): passa/estoura a guarda, gasto
// desconhecido (sem base, ilegível, chave trocada) é fail-safe, o BUDGET_USD do filho nunca sai
// "0" (= ilimitado no config.js). O `run` sobe filhos REAIS (node -e) com a leitura injetada: a
// guarda derruba o filho que passa do limite, e o filho recebe BUDGET_USD/LLM_PROVIDER. O
// getKeyUsage é exercitado contra um servidor HTTP LOCAL (OPENROUTER_BASE_URL lido em call-time).
// Nada toca o NC_HOME real nem a OpenRouter. npm test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';

// NC_HOME temporário ANTES de qualquer import que alcance o config.js (keys.js → config.js cria e
// semeia o NC_HOME no load). Import dinâmico porque o `import` estático é IÇADO.
const TMP = mkdtempSync(path.join(os.tmpdir(), 'nc-devspend-'));
process.env.NC_HOME = TMP;
after(() => rmSync(TMP, { recursive: true, force: true }));

const {
  decide, childBudget, pollAction, exitCodeFor, parseArgv, makeRecord, redactCmd, envPins,
  formatReport, loadState, saveState, appendHistory, runGuarded, round8,
} = await import('../scripts/dev-spend.mjs');

const BASE = 116.20680192; // a base real do feat/jev (TASK_PLAN, decisão 9)
const GUARD = 1.6;
const quiet = { info() {}, warn() {}, error() {} };
let fileSeq = 0;
const stateFile = (extra = {}) => {
  const f = path.join(TMP, `dev-spend-${process.pid}-${++fileSeq}.json`);
  saveState(f, { baseline: BASE, cap: 2, guard: GUARD, createdAt: '2026-09-26T00:00:00.000Z', history: [], ...extra });
  return f;
};

// ---- decide ----

test('decide: dentro da guarda → ok, com gasto/sobra/projeção arredondados em 8 casas', () => {
  const d = decide({ baseline: BASE, guard: GUARD, usage: BASE + 0.00077, need: 0.04 });
  assert.equal(d.ok, true);
  assert.equal(d.unknown, false);
  assert.equal(d.spent, 0.00077);
  assert.equal(d.remaining, round8(GUARD - 0.00077));
  assert.equal(d.projected, 0.04077);
  assert.equal(d.need, 0.04);
});

test('decide: gasto + need acima da guarda → recusa (não desconhecido)', () => {
  const d = decide({ baseline: BASE, guard: GUARD, usage: BASE + 1.5, need: 0.2 });
  assert.equal(d.ok, false);
  assert.equal(d.unknown, false);
  assert.equal(d.projected, 1.7);
  // exatamente NA guarda ainda cabe (o limite é "passar da guarda")
  assert.equal(decide({ baseline: BASE, guard: GUARD, usage: BASE + 1.5, need: 0.1 }).ok, true);
});

test('decide: sobra zero nunca é ok — BUDGET_USD=0 no filho seria orçamento ILIMITADO', () => {
  const d = decide({ baseline: BASE, guard: GUARD, usage: BASE + GUARD, need: 0 });
  assert.equal(d.remaining, 0);
  assert.equal(d.ok, false);
  assert.equal(d.unknown, false);
});

test('decide: desconhecido é fail-safe (sem base, uso ilegível, need inválido)', () => {
  for (const args of [
    { baseline: null, guard: GUARD, usage: BASE, need: 0 },
    { baseline: BASE, guard: GUARD, usage: null, need: 0 },
    { baseline: BASE, guard: GUARD, usage: 'n/d', need: 0 },
    { baseline: BASE, guard: 0, usage: BASE, need: 0 },
    { baseline: BASE, guard: GUARD, usage: BASE, need: -1 },
    { baseline: BASE, guard: GUARD, usage: BASE, need: 'x' },
  ]) {
    const d = decide(args);
    assert.equal(d.ok, false, JSON.stringify(args));
    assert.equal(d.unknown, true, JSON.stringify(args));
    assert.ok(d.reason);
    assert.equal(d.spent, null);
  }
});

test('decide: chave TROCADA (uso abaixo da base ou label diferente) é desconhecido, nunca gasto negativo', () => {
  const abaixo = decide({ baseline: BASE, guard: GUARD, usage: 0.01, need: 0 });
  assert.equal(abaixo.unknown, true, 'sem o corte o gasto seria -116 e a guarda nunca dispararia');
  assert.match(abaixo.reason, /abaixo da base/);
  const outra = decide({ baseline: BASE, guard: GUARD, usage: BASE + 0.1, need: 0, keyLabel: 'sk-or-v1…aaaa', label: 'sk-or-v1…bbbb' });
  assert.equal(outra.unknown, true);
  assert.match(outra.reason, /chave diferente/);
  // label ausente em qualquer lado não bloqueia (a base pode ter sido gravada com --value sem rede)
  assert.equal(decide({ baseline: BASE, guard: GUARD, usage: BASE + 0.1, need: 0, keyLabel: null, label: 'x' }).ok, true);
});

// ---- childBudget ----

test('childBudget: sobra truncada em 6 casas, piso 1e-6, null sem sobra', () => {
  assert.equal(childBudget({ remaining: 1.59923 }), '1.599230');
  assert.equal(childBudget({ remaining: 0.1234567891 }), '0.123456', 'trunca, não arredonda p/ cima');
  assert.equal(childBudget({ remaining: 0.0000001 }), '0.000001', 'nunca "0" (= ilimitado)');
  assert.equal(childBudget({ remaining: 0 }), null);
  assert.equal(childBudget({ remaining: null }), null);
  // Teto do filho = o need da etapa (não a guarda inteira): um filho sem --budget próprio não
  // gasta o resto do dev numa etapa descontrolada.
  assert.equal(childBudget({ remaining: 1.5, need: 0.04 }), '0.040000');
  assert.equal(childBudget({ remaining: 0.01, need: 0.04 }), '0.010000', 'sobra menor que o need: a sobra');
  assert.equal(childBudget({ remaining: 1.5, need: 0 }), '0.000001', 'need 0: piso, nunca "0" (= ilimitado)');
});

// ---- pollAction ----

test('pollAction: derruba só quando o gasto PASSA da guarda; avisa quando a etapa passa do need', () => {
  const before = BASE + 0.1;
  const ok = pollAction({ baseline: BASE, guard: GUARD, usage: BASE + 0.12, need: 0.04, before });
  assert.equal(ok.action, 'continue');
  assert.equal(ok.stepDelta, 0.02);
  assert.equal(ok.overNeed, false);
  const passouNeed = pollAction({ baseline: BASE, guard: GUARD, usage: BASE + 0.2, need: 0.04, before });
  assert.equal(passouNeed.action, 'continue', 'o need é o teto da etapa (do filho), não a guarda');
  assert.equal(passouNeed.overNeed, true);
  assert.equal(pollAction({ baseline: BASE, guard: GUARD, usage: BASE + GUARD, need: 0.04, before }).action, 'continue');
  const estourou = pollAction({ baseline: BASE, guard: GUARD, usage: BASE + 1.61, need: 0.04, before });
  assert.equal(estourou.action, 'kill');
  assert.equal(estourou.reason, 'guard');
  assert.equal(estourou.spent, 1.61);
});

test('pollAction: leitura falha conta como cega; derruba ao atingir maxBlind; leitura boa zera o contador', () => {
  let blind = 0;
  for (let i = 1; i < 3; i++) {
    const a = pollAction({ baseline: BASE, guard: GUARD, usage: null, blind, maxBlind: 3 });
    assert.equal(a.action, 'continue');
    assert.equal(a.blind, i);
    assert.ok(a.detail);
    blind = a.blind;
  }
  const cega = pollAction({ baseline: BASE, guard: GUARD, usage: null, blind, maxBlind: 3 });
  assert.equal(cega.action, 'kill');
  assert.equal(cega.reason, 'blind');
  assert.equal(pollAction({ baseline: BASE, guard: GUARD, usage: BASE, blind: 2, maxBlind: 3 }).blind, 0);
});

// ---- utilitários ----

test('exitCodeFor: 3 se a guarda derrubou; senão o do filho; 127 se não subiu; sinal → 128+n', () => {
  assert.equal(exitCodeFor({ killedBy: 'guard', code: 0 }), 3);
  assert.equal(exitCodeFor({ code: 0 }), 0);
  assert.equal(exitCodeFor({ code: 4 }), 4);
  assert.equal(exitCodeFor({ spawnError: new Error('ENOENT') }), 127);
  assert.equal(exitCodeFor({ signal: 'SIGTERM' }), 128 + os.constants.signals.SIGTERM);
});

test('parseArgv: subcomando, flags (--k v / --k=v / booleanas) e o comando intacto após o 1º --', () => {
  const p = parseArgv(['run', '--need', '0.04', '--poll-ms=500', '--', 'node', 'x.js', '--max-usd', '0.04', '--', 'y']);
  assert.equal(p.sub, 'run');
  assert.equal(p.flags.need, '0.04');
  assert.equal(p.flags['poll-ms'], '500');
  assert.deepEqual(p.cmd, ['node', 'x.js', '--max-usd', '0.04', '--', 'y']);
  const b = parseArgv(['baseline', '--force', '--value', '116.20680192']);
  assert.equal(b.flags.force, true);
  assert.equal(b.flags.value, '116.20680192');
  assert.equal(parseArgv(['report', '--offline']).flags.offline, true);
});

test('redactCmd/makeRecord: chave nunca vai p/ o histórico; delta = after - before', () => {
  const key = `sk-or-v1-${'a1'.repeat(32)}`;
  const cmd = redactCmd(['node', 'x.js', `--key=${key}`, 'com espaço']);
  assert.doesNotMatch(cmd, /a1a1a1a1/);
  assert.match(cmd, /\[REDACTED\]/);
  assert.match(cmd, /"com espaço"/);
  const r = makeRecord({ cmd: ['node', 'x.js'], need: 0.04, before: BASE, after: BASE + 0.0123, code: 0, startedAt: new Date(Date.now() - 1000) });
  assert.equal(r.delta, 0.0123);
  assert.equal(r.cmd, 'node x.js');
  assert.ok(r.ms >= 1000);
  assert.ok(!Number.isNaN(Date.parse(r.at)));
  assert.equal(makeRecord({ cmd: ['x'], need: 0, before: BASE, after: null }).delta, null, 'sem leitura final: delta desconhecido');
});

test('envPins: .env que fixa LLM_PROVIDER=deepseek bloqueia; BUDGET_USD do .env é detectado', () => {
  const shell = { PATH: '/bin' };
  const loaded = { PATH: '/bin', LLM_PROVIDER: 'deepseek', BUDGET_USD: '0.5' };
  const p = envPins(shell, loaded);
  assert.equal(p.providerBlocks, true);
  assert.equal(p.provider.fromDotEnv, true);
  assert.equal(p.budget.fromDotEnv, true);
  assert.equal(p.budget.value, '0.5');
  const limpo = envPins(shell, { PATH: '/bin' });
  assert.equal(limpo.providerBlocks, false);
  assert.equal(limpo.budget.fromDotEnv, false);
  assert.equal(limpo.budget.uncertain, false);
  assert.equal(envPins(shell, { LLM_PROVIDER: 'openrouter' }).providerBlocks, false);
  // mesmo valor antes/depois: não dá p/ provar que não vem de um .env → deepseek ainda bloqueia
  assert.equal(envPins({ LLM_PROVIDER: 'DeepSeek' }, { LLM_PROVIDER: 'DeepSeek' }).providerBlocks, true);
});

test('formatReport: tabela + total dos deltas medidos + gasto fora do dev-spend com leitura ao vivo', () => {
  const st = {
    baseline: BASE, cap: 2, guard: GUARD, createdAt: '2026-09-26T00:00:00.000Z', source: 'manual',
    history: [
      { cmd: 'node eval/jev/run.mjs --stage smoke', need: 0.04, delta: 0.012, at: '2026-09-27T01:02:03.000Z', code: 0 },
      { cmd: 'npm run crawl', need: 0.06, delta: null, at: '2026-09-27T02:00:00.000Z', code: null, killedBy: 'guard' },
    ],
  };
  const txt = formatReport(st, { usage: BASE + 0.02 });
  assert.match(txt, /base US\$ 116\.20680192/);
  assert.match(txt, /guarda US\$ 1\.60/);
  assert.match(txt, /stage smoke/);
  assert.match(txt, /morto:guard/);
  assert.match(txt, /total registrado: US\$ 0\.01200000 em 2 execução\(ões\) \(1 sem medição\)/);
  assert.match(txt, /desde a base: US\$ 0\.02000000 \(fora do dev-spend run: US\$ 0\.00800000\)/);
  assert.match(formatReport({ ...st, history: [] }), /nenhuma execução/);
  assert.match(formatReport(null), /sem base/);
});

test('loadState/saveState/appendHistory: gravação atômica, arquivo corrompido é erro (não zera)', () => {
  const f = stateFile();
  appendHistory(f, { cmd: 'a', delta: 0.1 });
  appendHistory(f, { cmd: 'b', delta: 0.2 });
  const { state } = loadState(f);
  assert.deepEqual(state.history.map((r) => r.cmd), ['a', 'b']);
  assert.equal(state.baseline, BASE);
  assert.deepEqual(loadState(path.join(TMP, 'nao-existe.json')), { state: null, error: null });
  const ruim = path.join(TMP, 'ruim.json');
  writeFileSync(ruim, '{ quebrado');
  const r = loadState(ruim);
  assert.equal(r.state, null);
  assert.match(r.error, /ilegível/);
  assert.throws(() => appendHistory(ruim, { cmd: 'x' }));
});

// ---- runGuarded (filhos reais, leitura injetada) ----

const NODE = process.execPath;
const reader = (values) => {
  let i = 0;
  return async () => {
    const v = values[Math.min(i++, values.length - 1)];
    return v == null ? { ok: false, status: 0, reason: 'teste', usage: null, label: null } : { ok: true, status: 200, usage: v, label: null };
  };
};

test('runGuarded: recusa sem subir o filho quando gasto + need passa da guarda (exit 3) ou é desconhecido (exit 2)', async () => {
  let spawned = 0;
  const spawnFn = () => { spawned++; throw new Error('não deveria subir'); };
  const f = stateFile();
  const over = await runGuarded({ cmd: ['x'], need: 0.2, file: f, readUsage: reader([BASE + 1.5]), spawnFn, report: quiet });
  assert.equal(over.exit, 3);
  assert.equal(over.started, false);
  const cego = await runGuarded({ cmd: ['x'], need: 0.01, file: f, readUsage: reader([null]), spawnFn, report: quiet });
  assert.equal(cego.exit, 2);
  assert.match(cego.decision.reason, /ilegível.* — teste$/);
  const semBase = await runGuarded({ cmd: ['x'], need: 0.01, file: path.join(TMP, 'sem-base.json'), readUsage: reader([BASE]), spawnFn, report: quiet });
  assert.equal(semBase.exit, 2);
  const explode = await runGuarded({ cmd: ['x'], need: 0.01, file: f, readUsage: () => { throw new Error('boom'); }, spawnFn, report: quiet });
  assert.equal(explode.exit, 2, 'leitura que lança = desconhecido, não derruba o processo');
  assert.equal(spawned, 0);
  assert.equal(loadState(f).state.history.length, 0, 'recusa não grava histórico');
});

test('runGuarded: filho recebe BUDGET_USD=min(need, sobra), LLM_PROVIDER=openrouter e a chave MEDIDA; registro com o delta', async () => {
  const f = stateFile();
  const envOut = path.join(TMP, `env-${process.pid}.json`);
  const script = "require('fs').writeFileSync(process.argv[1], JSON.stringify({ b: process.env.BUDGET_USD, p: process.env.LLM_PROVIDER, g: process.env.DEV_SPEND_GUARDED, k: process.env.OPENROUTER_API_KEY }))";
  const res = await runGuarded({
    cmd: [NODE, '-e', script, envOut],
    need: 0.04,
    file: f,
    readUsage: reader([BASE + 0.1, BASE + 0.13]),
    env: { PATH: process.env.PATH, LLM_PROVIDER: 'deepseek', OPENROUTER_API_KEY: 'sk-or-test-shell' },
    childEnv: { OPENROUTER_API_KEY: 'sk-or-test-measured' },
    pollMs: 60000,
    settleMs: 0,
    stdio: 'ignore',
    report: quiet,
  });
  assert.equal(res.exit, 0);
  assert.equal(res.started, true);
  const seen = JSON.parse(readFileSync(envOut, 'utf8'));
  assert.equal(seen.b, '0.040000', 'teto do filho = o need (0.04), não a sobra até a guarda (1.5)');
  assert.equal(seen.p, 'openrouter', 'o provedor do shell é sobrescrito no env do filho');
  assert.equal(seen.k, 'sk-or-test-measured', 'o filho gasta com a chave que a guarda MEDE, não a do shell');
  assert.equal(seen.g, '1');
  const hist = loadState(f).state.history;
  assert.equal(hist.length, 1);
  assert.equal(hist[0].delta, 0.03);
  assert.equal(hist[0].need, 0.04);
  assert.equal(hist[0].before, BASE + 0.1);
  assert.equal(hist[0].code, 0);
  assert.equal(hist[0].killedBy, null);
});

test('runGuarded: gasto passa da guarda durante a execução → SIGTERM no filho, exit 3, killedBy=guard', async () => {
  const f = stateFile();
  const t0 = Date.now();
  const res = await runGuarded({
    cmd: [NODE, '-e', 'setInterval(() => {}, 1000)'],
    need: 0.04,
    file: f,
    // 1ª leitura (check) ok; o poll vê o gasto subir e passar de 1.6
    readUsage: reader([BASE + 0.1, BASE + 0.5, BASE + 1.7]),
    pollMs: 40,
    graceMs: 2000,
    settleMs: 0,
    stdio: 'ignore',
    report: quiet,
  });
  assert.equal(res.exit, 3);
  assert.equal(res.record.killedBy, 'guard');
  assert.equal(res.record.signal, 'SIGTERM', 'o SIGTERM bastou (sem precisar do SIGKILL)');
  assert.ok(Date.now() - t0 < 10000);
  assert.equal(loadState(f).state.history[0].killedBy, 'guard');
});

test('runGuarded: a guarda derruba o GRUPO — o neto (ex.: npm → node → Chromium) morre junto', { skip: process.platform === 'win32' }, async () => {
  const f = stateFile();
  const pidFile = path.join(TMP, `neto-${process.pid}.pid`);
  const script = [
    "const { spawn } = require('child_process');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "require('fs').writeFileSync(process.argv[1], String(g.pid));",
    'setInterval(() => {}, 1000);',
  ].join(' ');
  // só estoura a guarda depois que o neto existe (o pid dele está no arquivo)
  const readUsage = async () => ({ ok: true, usage: existsSync(pidFile) ? BASE + 1.7 : BASE + 0.1, label: null });
  const res = await runGuarded({
    cmd: [NODE, '-e', script, pidFile], need: 0.04, file: f, readUsage,
    pollMs: 40, graceMs: 2000, settleMs: 0, stdio: 'ignore', report: quiet,
  });
  assert.equal(res.record.killedBy, 'guard');
  const neto = Number(readFileSync(pidFile, 'utf8'));
  const vivo = () => { try { process.kill(neto, 0); return true; } catch { return false; } };
  const t0 = Date.now();
  while (vivo() && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
  if (vivo()) process.kill(neto, 'SIGKILL'); // não deixa lixo mesmo se a asserção falhar
  assert.equal(vivo(), false, 'o SIGTERM foi p/ o grupo inteiro, não só p/ o filho direto');
});

test('runGuarded: medição cega por maxBlind leituras seguidas também derruba (fail-safe)', async () => {
  const f = stateFile();
  const res = await runGuarded({
    cmd: [NODE, '-e', 'setInterval(() => {}, 1000)'],
    need: 0.04,
    file: f,
    readUsage: reader([BASE + 0.1, null]),
    pollMs: 30,
    maxBlind: 3,
    graceMs: 2000,
    settleMs: 0,
    stdio: 'ignore',
    report: quiet,
  });
  assert.equal(res.exit, 3);
  assert.equal(res.record.killedBy, 'blind');
  assert.equal(res.record.after, null);
  assert.equal(res.record.delta, null);
});

test('runGuarded: comando inexistente → exit 127 e ainda registra a tentativa', async () => {
  const f = stateFile();
  const res = await runGuarded({
    cmd: [path.join(TMP, 'nao-existe-bin')],
    need: 0,
    file: f,
    readUsage: reader([BASE + 0.1]),
    settleMs: 0,
    stdio: 'ignore',
    report: quiet,
  });
  assert.equal(res.exit, 127);
  assert.equal(loadState(f).state.history.length, 1);
});

// ---- getKeyUsage (servidor LOCAL; OPENROUTER_BASE_URL lido em call-time) ----

const { getKeyUsage } = await import('../src/keys.js');
const { setRuntimeKey } = await import('../src/config.js');

const hits = [];
const server = http.createServer((req, res) => {
  hits.push({ url: req.url, auth: req.headers.authorization });
  const auth = req.headers.authorization || '';
  if (req.url !== '/api/v1/key') {
    res.writeHead(404);
    res.end();
  } else if (auth === 'Bearer sk-or-v1-ok' || auth === 'Bearer sk-or-v1-live') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { label: 'sk-or-v1-0e6...a1b2', usage: 116.20757192, limit: null, limit_remaining: null, is_free_tier: false } }));
  } else if (auth === 'Bearer sk-or-v1-lixo') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>proxy</html>');
  } else {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"No auth credentials found","code":401}}');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIG_BASE = process.env.OPENROUTER_BASE_URL;
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}/api/v1`;
after(() => {
  if (ORIG_BASE === undefined) delete process.env.OPENROUTER_BASE_URL;
  else process.env.OPENROUTER_BASE_URL = ORIG_BASE;
  server.close();
});

test('getKeyUsage: 200 → usage/limit/limit_remaining numéricos e label mascarado (origin do OPENROUTER_BASE_URL)', async () => {
  const r = await getKeyUsage('sk-or-v1-ok', { timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.usage, 116.20757192);
  assert.equal(r.limit, null, 'limit null = chave sem teto (não é zero)');
  assert.equal(r.limit_remaining, null);
  assert.equal(r.label, 'sk-or-v1…a1b2');
  assert.equal(hits.at(-1).url, '/api/v1/key', 'usa só o ORIGIN da base (/api/v1 não duplica)');
});

test('getKeyUsage: sem argumento usa a OPENROUTER_API_KEY por live binding (setRuntimeKey)', async () => {
  setRuntimeKey('sk-or-v1-live', 'openrouter');
  const r = await getKeyUsage(undefined, { timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(hits.at(-1).auth, 'Bearer sk-or-v1-live');
});

test('getKeyUsage: 401, corpo não-JSON, chave vazia e rede fora NÃO lançam — números em null', async () => {
  const ruim = await getKeyUsage('sk-or-v1-errada', { timeoutMs: 5000 });
  assert.deepEqual(
    { ok: ruim.ok, status: ruim.status, usage: ruim.usage, label: ruim.label },
    { ok: false, status: 401, usage: null, label: null },
  );
  const lixo = await getKeyUsage('sk-or-v1-lixo', { timeoutMs: 5000 });
  assert.equal(lixo.ok, false);
  assert.match(lixo.reason, /sem data\.usage/);
  const n = hits.length;
  const vazia = await getKeyUsage('', { timeoutMs: 5000 });
  assert.equal(vazia.reason, 'chave vazia');
  assert.equal(hits.length, n, 'chave vazia não toca a rede');
  const saved = process.env.OPENROUTER_BASE_URL;
  process.env.OPENROUTER_BASE_URL = 'http://127.0.0.1:1/api/v1'; // porta fechada: recusa na hora
  try {
    const net = await getKeyUsage('sk-or-v1-ok', { timeoutMs: 3000 });
    assert.equal(net.ok, false);
    assert.equal(net.status, 0);
    assert.equal(net.usage, null);
    assert.ok(net.reason);
  } finally {
    process.env.OPENROUTER_BASE_URL = saved;
  }
});

test('o arquivo de estado dos testes fica no NC_HOME temporário (nunca no real)', () => {
  assert.ok(existsSync(TMP));
  assert.ok(!existsSync(path.join(os.homedir(), '.newsletter-crawler', `dev-spend-${process.pid}-1.json`)));
});
