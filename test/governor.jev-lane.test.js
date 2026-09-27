// Lane 'jev' do governador + limitação de taxa por lane (src/ratelimit.js), sem rede e sem relógio
// real: o governador é dirigido com leitor de memória/CPU e relógio ROTEIRIZADOS (como o
// governor.aimd.test.js) e a janela de penalidade / o portão de rps rodam num relógio FALSO
// injetado (sleep controlado pelo teste) — timing determinístico, zero espera de verdade.
// Cobre: teto da lane jev (JEV_CONCURRENCY ∩ --parallel, piso 2, independente do perfil),
// isolamento llm × jev, reportRateLimit(lane) halvando só a lane dada (e o teto calibrado dela),
// convergência no teto, stageWindow(override, lane), getCalibration()/getTelemetry() e o timing do
// portão de rps (GCRA) e da janela de 429 (Retry-After exato/'max', backoff, abort). npm test.
import { test, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxEnv } from './helpers/env.js';

// Sandbox ANTES do import (governor.js -> config.js carrega os .env no load). Os knobs da lane jev
// e os tetos calibrados vão VAZIOS p/ o NC_HOME/.env semeado (vence o .env do repo): o teste não
// herda JEV_CONCURRENCY/GOVERNOR_*_CAP/JEV_MAX_RPS da máquina.
const SANDBOX = sandboxEnv(
  { JEV_CONCURRENCY: '', GOVERNOR_JEV_CAP: '', GOVERNOR_LLM_CAP: '', JEV_MAX_RPS: '' },
  { homePrefix: 'nc-governor-jev-' },
);
after(() => SANDBOX.restore());

const {
  initGovernor, stopGovernor, governorTick, getLane, stageWindow, reportRateLimit, setProfile,
  getTelemetry, getCalibration,
} = await import('../src/governor.js');
const {
  PENALTY_CAP_MS, DEFAULT_JEV_MAX_RPS, retryAfterMsOf, backoffMs, abortableSleep, createPenaltyWindow,
  createRateGate, jevMaxRps, penaltyWindowFor, rateGateFor, resetRateLimits,
} = await import('../src/ratelimit.js');

const GIB = 1024 ** 3;
const flush = () => new Promise((r) => setImmediate(r));

// Máquina roteirizada com folga de RAM/CPU (estado 'ok'): o crescimento das lanes de API só
// depende dos relógios de 429/dwell — é o que estes testes exercitam.
function makeEnv() {
  const env = { now: 100_000 };
  env.readMem = () => ({ totalBytes: 32 * GIB, availableBytes: 20 * GIB });
  env.readCpu = () => 80;
  env.clock = () => env.now;
  env.tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      env.now += 1000;
      governorTick(env.now);
    }
  };
  return env;
}

function init(env, opts = {}) {
  return initGovernor({
    parallel: 32,
    profile: 'crawl',
    readMem: env.readMem,
    readCpu: env.readCpu,
    now: env.clock,
    autoStart: false,
    ramMaxPct: 80,
    ramHysteresisPct: 10,
    ramFreeTargetPct: 20,
    cpuFreeTargetPct: 40,
    llmCap: 0,
    jevCap: 0,
    jevConcurrency: 8,
    ...opts,
  });
}

// Relógio falso p/ o ratelimit: sleep(ms) registra um timer; advance(ms) anda o tempo e resolve os
// timers vencidos EM ORDEM, drenando as microtasks entre um e outro.
function fakeClock(start = 1_000_000) {
  const c = { t: start, timers: [] };
  c.now = () => c.t;
  c.sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const tm = { due: c.t + Math.max(0, ms), resolve };
      c.timers.push(tm);
      signal?.addEventListener(
        'abort',
        () => {
          c.timers = c.timers.filter((x) => x !== tm);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  c.advance = async (ms) => {
    const end = c.t + ms;
    for (;;) {
      await flush();
      c.timers.sort((a, b) => a.due - b.due);
      const next = c.timers[0];
      if (!next || next.due > end) break;
      c.timers.shift();
      c.t = next.due;
      next.resolve();
    }
    c.t = end;
    await flush();
  };
  return c;
}

afterEach(() => {
  stopGovernor();
  resetRateLimits();
  delete process.env.JEV_CONCURRENCY;
  delete process.env.GOVERNOR_JEV_CAP;
  delete process.env.JEV_MAX_RPS;
});

// ---------------------------------------------------------------- governador: lane jev

test('lane jev: teto JEV_CONCURRENCY (8) independente do perfil; setProfile não mexe nela', () => {
  const env = makeEnv();
  init(env, { profile: 'crawl' });
  assert.equal(getLane('jev').concurrency, 8);
  setProfile('llm-only');
  assert.equal(getLane('jev').concurrency, 8, 'crawl -> llm-only: lane jev intacta');
  stopGovernor();
  init(env, { profile: 'llm-only' });
  assert.equal(getLane('jev').concurrency, 8, 'perfil llm-only parte do mesmo teto');
});

test('lane jev: --parallel é o teto global (min) e o piso é 2', () => {
  const env = makeEnv();
  init(env, { parallel: 4 });
  assert.equal(getLane('jev').concurrency, 4, 'min(8, parallel 4)');
  stopGovernor();
  init(env, { parallel: 1 });
  assert.equal(getLane('jev').concurrency, 2, 'parallel 1 -> piso 2');
  stopGovernor();
  init(env, { jevConcurrency: 1 });
  assert.equal(getLane('jev').concurrency, 2, 'JEV_CONCURRENCY 1 -> piso 2');
});

test('lane jev: JEV_CONCURRENCY e GOVERNOR_JEV_CAP são lidos do env NA HORA do init', () => {
  const env = makeEnv();
  process.env.JEV_CONCURRENCY = '5';
  init(env, { jevConcurrency: undefined, jevCap: undefined });
  assert.equal(getLane('jev').concurrency, 5, 'env JEV_CONCURRENCY=5');
  stopGovernor();
  process.env.JEV_CONCURRENCY = 'abc';
  init(env, { jevConcurrency: undefined, jevCap: undefined });
  assert.equal(getLane('jev').concurrency, 8, 'valor inválido -> default 8');
  stopGovernor();
  delete process.env.JEV_CONCURRENCY;
  process.env.GOVERNOR_JEV_CAP = '3';
  init(env, { jevConcurrency: undefined, jevCap: undefined });
  assert.equal(getLane('jev').concurrency, 3, 'teto calibrado persistido (GOVERNOR_JEV_CAP=3)');
  assert.equal(getCalibration().jevCap, 3);
  assert.equal(getCalibration().dirty.jev, true, 'teto abaixo do alloc -> segue persistível');
});

test('reportRateLimit("jev") halva SÓ a lane jev e o teto dela; a llm fica intacta', () => {
  const env = makeEnv();
  init(env);
  assert.equal(getLane('llm').concurrency, 32);
  assert.equal(getLane('jev').concurrency, 8);
  reportRateLimit('jev');
  assert.equal(getLane('jev').concurrency, 4, 'jev 8 -> 4');
  assert.equal(getLane('llm').concurrency, 32, 'llm não é tocada');
  let cal = getCalibration();
  assert.equal(cal.jevCap, 4);
  assert.equal(cal.llmCap, 32);
  assert.deepEqual(cal.rateLimitEvents, { llm: 0, jev: 1 });
  assert.deepEqual(cal.dirty, { llm: false, jev: true });
  reportRateLimit('jev');
  reportRateLimit('jev');
  assert.equal(getLane('jev').concurrency, 2, '4 -> 2 -> piso 2 (nunca abaixo)');
  assert.equal(getCalibration().jevCap, 2);

  reportRateLimit(); // sem argumento = 'llm' (chamadores antigos, ex.: src/llm.js)
  assert.equal(getLane('llm').concurrency, 16, 'llm 32 -> 16');
  assert.equal(getLane('jev').concurrency, 2, 'o 429 do chat não mexe na lane jev');
  cal = getCalibration();
  assert.deepEqual(cal.rateLimitEvents, { llm: 1, jev: 3 });
  assert.deepEqual(cal.dirty, { llm: true, jev: true });
});

test('reportRateLimit numa lane sem AIMD de API é ignorado (fail-open)', () => {
  const env = makeEnv();
  init(env);
  assert.doesNotThrow(() => reportRateLimit('fetch'));
  assert.doesNotThrow(() => reportRateLimit('nope'));
  assert.equal(getLane('fetch').concurrency, 8);
  assert.deepEqual(getCalibration().rateLimitEvents, { llm: 0, jev: 0 });
});

test('convergência: após 429 a lane jev NÃO recresce além do teto calibrado; abaixo dele, +1/10s', () => {
  const env = makeEnv();
  init(env);
  reportRateLimit('jev'); // 8 -> 4 (lane e teto)
  env.tick(120);
  assert.equal(getLane('jev').concurrency, 4, '2 min limpos: 4 É o teto calibrado');
  assert.equal(getCalibration().jevCap, 4);

  stopGovernor();
  init(env); // teto 8 de novo; derruba só a LANE (ex.: ajuste externo) p/ exercitar o grow
  getLane('jev').concurrency = 2;
  env.tick(1);
  assert.equal(getLane('jev').concurrency, 3, '+1 no 1º tick (relógios zerados no init)');
  env.tick(9);
  assert.equal(getLane('jev').concurrency, 3, 'ainda dentro dos 10s de dwell');
  env.tick(1);
  assert.equal(getLane('jev').concurrency, 4);
  env.tick(200);
  assert.equal(getLane('jev').concurrency, 8, 'para no teto (8), nunca passa');
});

test('isolamento do dwell: 429 do jev segura só o grow do jev; a llm recresce no relógio dela', () => {
  const env = makeEnv();
  init(env);
  getLane('llm').concurrency = 10; // abaixo do teto 32
  getLane('jev').concurrency = 3; // abaixo do teto 8
  env.tick(10); // ambos +1 (10s limpos desde o init)
  assert.equal(getLane('llm').concurrency, 11);
  assert.equal(getLane('jev').concurrency, 4);
  reportRateLimit('jev'); // jev 4 -> 2, teto 8 -> 2
  env.tick(10);
  assert.equal(getLane('llm').concurrency, 12, 'llm segue crescendo: o 429 foi do jev');
  assert.equal(getLane('jev').concurrency, 2, 'jev convergiu no teto calibrado 2');
});

test('lanes isoladas: lane jev saturada não bloqueia admissões na lane llm (e vice-versa)', async () => {
  const env = makeEnv();
  init(env, { parallel: 4, jevConcurrency: 2 });
  const jev = getLane('jev');
  const llm = getLane('llm');
  const release = [];
  const hold = (lane) => lane(() => new Promise((r) => release.push(r)));
  const held = [hold(jev), hold(jev), hold(jev), hold(jev)];
  await flush();
  assert.equal(jev.activeCount, 2);
  assert.equal(jev.pendingCount, 2, 'jev cheia: 2 na fila');
  let llmRan = false;
  await llm(async () => {
    llmRan = true;
  });
  assert.equal(llmRan, true, 'a llm admite na hora com a jev saturada');
  release.splice(0).forEach((r) => r());
  await flush();
  release.splice(0).forEach((r) => r());
  await Promise.all(held);
  assert.equal(jev.activeCount, 0);
});

test('stageWindow(override, lane): lane default llm; "jev" dimensiona pela lane jev', () => {
  const env = makeEnv();
  init(env);
  assert.equal(stageWindow(0), 32, 'sem lane = llm (chamadores antigos)');
  assert.equal(stageWindow(0, 'jev'), 8, 'sem override: janela = lane jev');
  assert.equal(stageWindow(3, 'jev'), 3, 'override menor vale');
  assert.equal(stageWindow(100, 'jev'), 8, 'override maior não fura a lane jev');
  reportRateLimit('jev');
  assert.equal(stageWindow(0, 'jev'), 4, 'segue a capacidade ATUAL da lane jev');
  assert.equal(stageWindow(0, 'llm'), 32, 'a llm não mudou');
  assert.equal(stageWindow(0, 'desconhecida'), 32, 'lane desconhecida cai na llm');
});

test('getTelemetry(): lanes.jev e calib.jevCap expostos', () => {
  const env = makeEnv();
  init(env);
  const tele = getTelemetry();
  assert.deepEqual(tele.lanes.jev, { capacity: 8, active: 0, queued: 0 });
  assert.equal(tele.calib.jevCap, 8);
  assert.equal(tele.calib.llmCap, 32);
  assert.deepEqual(tele.calib.rateLimitEvents, { llm: 0, jev: 0 });
  reportRateLimit('jev');
  assert.equal(getTelemetry().lanes.jev.capacity, 4);
  assert.equal(getTelemetry().calib.jevCap, 4);
});

test('getCalibration(): jevCap persistido clampa piso..alloc; dirty por lane', () => {
  const env = makeEnv();
  init(env, { jevCap: 4 });
  assert.equal(getLane('jev').concurrency, 4, 'cap 4 < alloc 8 -> parte em 4');
  assert.deepEqual(getCalibration().dirty, { llm: false, jev: true });
  env.tick(60);
  assert.equal(getLane('jev').concurrency, 4, 'sem 429 não cresce além do cap calibrado');
  stopGovernor();
  init(env, { jevCap: 999 });
  assert.equal(getLane('jev').concurrency, 8, 'cap 999 -> clamp no alloc');
  assert.equal(getCalibration().dirty.jev, false);
  stopGovernor();
  init(env, { jevCap: 1 });
  assert.equal(getLane('jev').concurrency, 2, 'cap 1 -> piso 2');
});

// ---------------------------------------------------------------- ratelimit: Retry-After e backoff

test('retryAfterMsOf: formatos de header, ausência (null) ≠ "0" (0)', () => {
  assert.equal(retryAfterMsOf({ headers: { 'retry-after': '0' } }), 0, "'0' = já pode");
  assert.equal(retryAfterMsOf({ headers: {} }), null, 'ausente = null');
  assert.equal(retryAfterMsOf(null), null);
  assert.equal(retryAfterMsOf({ headers: { 'retry-after': '2' } }), 2000, 'segundos -> ms');
  assert.equal(retryAfterMsOf({ headers: { 'retry-after-ms': '150', 'retry-after': '9' } }), 150, 'retry-after-ms vence');
  assert.equal(retryAfterMsOf({ 'retry-after': ['3'] }), 3000, 'objeto de headers direto, valor array');
  const sdkHeaders = new Headers({ 'Retry-After': '1' });
  assert.equal(retryAfterMsOf({ headers: sdkHeaders }), 1000, 'Headers do SDK (get)');
  assert.equal(retryAfterMsOf({ response: { headers: { 'retry-after': '4' } } }), 4000, 'erro do got');
  const now = Date.parse('2026-09-27T12:00:00Z');
  assert.equal(
    retryAfterMsOf({ headers: { 'retry-after': 'Sun, 27 Sep 2026 12:00:05 GMT' } }, now),
    5000,
    'HTTP-date',
  );
  assert.equal(retryAfterMsOf({ headers: { 'retry-after': 'lixo' } }), null, 'inválido = null');
  assert.equal(retryAfterMsOf({ headers: { 'retry-after': '-1' } }), null, 'negativo = null');
  assert.equal(retryAfterMsOf(250), 250, 'número = ms');
  assert.equal(retryAfterMsOf(new Error('sem headers')), null);
});

test('backoffMs: base·2^n·(0.5+rand), teto 60s', () => {
  assert.equal(backoffMs(1, { random: () => 0.5 }), 2000, 'base 1s, n=1, jitter neutro');
  assert.equal(backoffMs(0, { baseMs: 250, random: () => 0 }), 125, 'jitter mínimo 0.5x');
  assert.equal(backoffMs(2, { baseMs: 250, random: () => 0.99 }), 250 * 4 * 1.49);
  assert.equal(backoffMs(30, { random: () => 0.5 }), PENALTY_CAP_MS, 'teto');
  assert.equal(backoffMs(3, { capMs: 1500, random: () => 0.5 }), 1500, 'teto custom');
});

// ---------------------------------------------------------------- ratelimit: janela de penalidade

test('janela: Retry-After explícito é EXATO (default); ausente = backoff exponencial; teto 60s', async () => {
  const c = fakeClock();
  const w = createPenaltyWindow({ now: c.now, sleep: c.sleep, random: () => 0.5, onRateLimit: null });
  assert.equal(w.bump({ headers: { 'retry-after': '0' } }), 0, "'0' -> sem espera");
  assert.equal(w.remainingMs(), 0);
  assert.equal(w.bump({ headers: { 'retry-after': '1' } }), 1000);
  assert.equal(w.remainingMs(), 1000);
  assert.equal(w.bump({ headers: {} }), 8000, 'sem header: 2^3·1s (3º bump) · jitter 1.0');
  assert.equal(w.bump({ headers: { 'retry-after': '600' } }), PENALTY_CAP_MS, 'Retry-After enorme: teto 60s');
  assert.equal(w.state().events, 4);
});

test('janela: política "max" (a do llm.js) = max(Retry-After, backoff); bump nunca encurta', () => {
  const c = fakeClock();
  const w = createPenaltyWindow({ retryAfter: 'max', now: c.now, sleep: c.sleep, random: () => 0.5, onRateLimit: null });
  assert.equal(w.bump({ headers: { 'retry-after': '0' } }), 2000, 'backoff 2s vence o 0');
  assert.equal(w.bump({ headers: { 'retry-after': '10' } }), 10_000, 'Retry-After 10s vence o backoff 4s');
  const w2 = createPenaltyWindow({ now: c.now, sleep: c.sleep, onRateLimit: null });
  w2.bump(5000);
  w2.bump(1000); // uma janela MENOR não encurta a vigente
  assert.equal(w2.remainingMs(), 5000);
});

test('janela: wait() segura até a janela abrir, re-checando extensões; settle() zera o backoff', async () => {
  const c = fakeClock();
  const w = createPenaltyWindow({ now: c.now, sleep: c.sleep, random: () => 0.5, onRateLimit: null });
  w.bump(3000);
  let done = false;
  const p = w.wait().then(() => {
    done = true;
  });
  await c.advance(2000);
  assert.equal(done, false, 'janela ainda aberta aos 2s');
  w.bump(4000); // outro 429 estende p/ t+2s+4s
  await c.advance(1500);
  assert.equal(done, false, 'aos 3.5s a janela foi ESTENDIDA — continua esperando');
  await c.advance(3000);
  await p;
  assert.equal(done, true);
  assert.equal(w.state().k, 2);
  w.settle();
  assert.equal(w.state().k, 0, 'janela limpa após sucesso: expoente zerado');
  // Sem janela vigente, wait() não dorme.
  let immediate = false;
  await w.wait().then(() => {
    immediate = true;
  });
  assert.equal(immediate, true);
});

test('janela: settle() com a janela ainda aberta NÃO zera o expoente', () => {
  const c = fakeClock();
  const w = createPenaltyWindow({ now: c.now, sleep: c.sleep, random: () => 0.5, onRateLimit: null });
  w.bump({ headers: {} });
  w.settle();
  assert.equal(w.state().k, 1);
});

test('janela: wait() abortável — rejeita com o motivo do abort', async () => {
  const c = fakeClock();
  const w = createPenaltyWindow({ now: c.now, sleep: c.sleep, onRateLimit: null });
  w.bump(10_000);
  const ac = new AbortController();
  const p = w.wait(ac.signal);
  await c.advance(100);
  ac.abort(new Error('job abortado'));
  await assert.rejects(p, /job abortado/);
  const ac2 = new AbortController();
  ac2.abort(new Error('já abortado'));
  await assert.rejects(w.wait(ac2.signal), /já abortado/);
});

test('janela: onRateLimit recebe (lane, {retryAfterMs, waitMs}); erro nele não derruba o bump', () => {
  const c = fakeClock();
  const calls = [];
  const w = createPenaltyWindow({ lane: 'x', now: c.now, sleep: c.sleep, onRateLimit: (...a) => calls.push(a) });
  w.bump({ headers: { 'retry-after': '2' } });
  assert.deepEqual(calls, [['x', { retryAfterMs: 2000, waitMs: 2000 }]]);
  const boom = createPenaltyWindow({ now: c.now, sleep: c.sleep, onRateLimit: () => {
    throw new Error('telemetria quebrada');
  } });
  assert.doesNotThrow(() => boom.bump(10));
});

test('janela da lane "jev": o bump avisa o governador — halva a lane jev, não a llm', () => {
  const env = makeEnv();
  init(env);
  const c = fakeClock();
  const w = createPenaltyWindow({ lane: 'jev', now: c.now, sleep: c.sleep });
  w.bump({ headers: { 'retry-after': '0' } });
  assert.equal(getLane('jev').concurrency, 4);
  assert.equal(getLane('llm').concurrency, 32);
  assert.equal(getCalibration().rateLimitEvents.jev, 1);
});

test('janela: coalesceMs — 429s em rajada contam como UM corte; depois da janela, corta de novo', () => {
  const c = fakeClock();
  const calls = [];
  const w = createPenaltyWindow({ lane: 'x', coalesceMs: 1000, now: c.now, sleep: c.sleep, onRateLimit: (l) => calls.push(l) });
  for (let i = 0; i < 8; i++) w.bump({ headers: { 'retry-after': '0' } });
  assert.equal(calls.length, 1, '8 respostas 429 simultâneas = 1 aviso');
  assert.equal(w.state().events, 8, 'mas todas contam como 429');
  assert.equal(w.state().notified, 1);
  c.t += 999;
  w.bump(0);
  assert.equal(calls.length, 1, 'ainda dentro de 1s do aviso');
  c.t += 1;
  w.bump(0);
  assert.equal(calls.length, 2, 'passado 1s: novo corte');
});

test('registro "jev": rajada de 429 halva a lane jev UMA vez (coalescida); llm avisa a cada 429', () => {
  const env = makeEnv();
  init(env);
  const c = fakeClock();
  const jw = penaltyWindowFor('jev', { now: c.now, sleep: c.sleep });
  for (let i = 0; i < 8; i++) jw.bump({ headers: { 'retry-after': '0' } });
  assert.equal(getLane('jev').concurrency, 4, '8 simultâneos: 8 -> 4 (não 8 -> 2)');
  assert.equal(getCalibration().jevCap, 4);
  c.t += 1000;
  jw.bump({ headers: { 'retry-after': '0' } });
  assert.equal(getLane('jev').concurrency, 2, 'novo 429 depois de 1s: 4 -> 2');
  const lw = penaltyWindowFor('llm', { now: c.now, sleep: c.sleep, random: () => 0.5 });
  lw.bump({ headers: {} });
  lw.bump({ headers: {} });
  assert.equal(getLane('llm').concurrency, 8, 'llm: cada 429 halva (32 -> 16 -> 8), como o llm.js');
});

// ---------------------------------------------------------------- ratelimit: portão de rps

test('portão rps: admissões concorrentes espaçadas por 1000/rps, em ordem FIFO', async () => {
  const c = fakeClock();
  const start = c.t;
  const g = createRateGate({ rps: 10, now: c.now, sleep: c.sleep });
  const admitted = [];
  const ps = Array.from({ length: 5 }, (_, i) => g.take().then((waited) => admitted.push([i, c.t - start, waited])));
  await c.advance(1000);
  await Promise.all(ps);
  assert.deepEqual(
    admitted,
    [
      [0, 0, 0],
      [1, 100, 100],
      [2, 200, 200],
      [3, 300, 300],
      [4, 400, 400],
    ],
  );
  assert.equal(g.state().admitted, 5);
});

test('portão rps: taxa sustentada nunca passa de rps (+ rajada) em qualquer janela de 1s', async () => {
  const c = fakeClock();
  const g = createRateGate({ rps: DEFAULT_JEV_MAX_RPS, burst: 3, now: c.now, sleep: c.sleep });
  const times = [];
  const ps = Array.from({ length: 60 }, () => g.take().then(() => times.push(c.t)));
  await c.advance(10_000);
  await Promise.all(ps);
  assert.equal(times.filter((t) => t === times[0]).length, 3, 'rajada: 3 imediatas');
  for (let i = 0; i < times.length; i++) {
    const inWindow = times.filter((t) => t >= times[i] && t < times[i] + 1000).length;
    assert.ok(inWindow <= DEFAULT_JEV_MAX_RPS + 3, `janela em ${i}: ${inWindow} > rps+burst`);
  }
  const span = times.at(-1) - times[0];
  assert.ok(span >= ((60 - 3) * 1000) / DEFAULT_JEV_MAX_RPS - 1, `60 admissões a 15 rps levam ≥ 3.8s (${span})`);
});

test('portão rps: tempo ocioso não acumula crédito além da rajada; rps 0 desliga; rps lido a cada take', async () => {
  const c = fakeClock();
  let rps = 10;
  const g = createRateGate({ rps: () => rps, now: c.now, sleep: c.sleep });
  assert.equal(await g.take(), 0);
  await c.advance(5000); // 5s ocioso
  assert.equal(await g.take(), 0, 'depois de ocioso, admite na hora');
  const p = g.take();
  await c.advance(100);
  assert.equal(await p, 100, 'mas só UMA: a seguinte volta a esperar 100ms');
  rps = 0;
  assert.equal(await g.take(), 0, 'rps 0: sem portão');
  assert.equal(await g.take(), 0);
  rps = 'lixo';
  assert.equal(await g.take(), 0, 'rps inválido: sem portão (fail-open)');
  const broken = createRateGate({ rps: () => {
    throw new Error('getter quebrado');
  }, now: c.now, sleep: c.sleep });
  assert.equal(await broken.take(), 0);
});

test('portão rps: abortar a espera devolve o slot (se ainda for o último reservado)', async () => {
  const c = fakeClock();
  const start = c.t;
  const g = createRateGate({ rps: 10, now: c.now, sleep: c.sleep });
  await g.take(); // slot 0
  const ac = new AbortController();
  const aborted = g.take(ac.signal); // slot 100
  await flush();
  ac.abort(new Error('cancelado'));
  await assert.rejects(aborted, /cancelado/);
  const p = g.take(); // herda o slot 100 devolvido (não vai p/ 200)
  let at = null;
  p.then(() => {
    at = c.t - start;
  });
  await c.advance(500);
  assert.equal(at, 100);
  const ac2 = new AbortController();
  ac2.abort(new Error('antes'));
  await assert.rejects(g.take(ac2.signal), /antes/);
});

test('portão rps com timers de verdade mockados (abortableSleep + Date.now default)', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  try {
    const g = createRateGate({ rps: 20 }); // 50ms entre admissões
    const seen = [];
    const ps = [0, 1, 2].map((i) => g.take().then(() => seen.push([i, Date.now()])));
    await flush();
    assert.deepEqual(seen, [[0, 0]]);
    mock.timers.tick(50);
    await flush();
    assert.deepEqual(seen, [[0, 0], [1, 50]]);
    mock.timers.tick(50);
    await Promise.all(ps);
    assert.deepEqual(seen, [[0, 0], [1, 50], [2, 100]]);
  } finally {
    mock.timers.reset();
  }
});

test('abortableSleep: resolve no prazo, rejeita no abort, ms<=0 resolve na hora', async () => {
  await abortableSleep(0);
  await abortableSleep(-5);
  const ac = new AbortController();
  const p = abortableSleep(60_000, ac.signal);
  ac.abort(new Error('parou'));
  await assert.rejects(p, /parou/);
  const ac2 = new AbortController();
  ac2.abort();
  await assert.rejects(abortableSleep(10, ac2.signal));
  await abortableSleep(5); // real, curto
});

// ---------------------------------------------------------------- ratelimit: registro por lane

test('registro: penaltyWindowFor/rateGateFor devolvem o MESMO singleton por lane; reset recria', () => {
  const a = penaltyWindowFor('jev');
  assert.equal(penaltyWindowFor('jev'), a, 'jev.js e search compartilham a janela');
  assert.notEqual(penaltyWindowFor('llm'), a, 'estado independente por lane');
  const g = rateGateFor('jev');
  assert.equal(rateGateFor('jev'), g);
  resetRateLimits();
  assert.notEqual(penaltyWindowFor('jev'), a);
  assert.notEqual(rateGateFor('jev'), g);
});

test('registro: janela da llm usa a política "max" (semântica atual do llm.js)', () => {
  const c = fakeClock();
  const w = penaltyWindowFor('llm', { now: c.now, sleep: c.sleep, random: () => 0.5, onRateLimit: null });
  assert.equal(w.bump({ headers: { 'retry-after': '0' } }), 2000);
  const j = penaltyWindowFor('jev', { now: c.now, sleep: c.sleep, onRateLimit: null });
  assert.equal(j.bump({ headers: { 'retry-after': '0' } }), 0, 'jev: Retry-After exato');
});

test('JEV_MAX_RPS: default 15, lido do env a cada take; 0 desliga; inválido volta ao default', () => {
  assert.equal(jevMaxRps(), 15);
  const g = rateGateFor('jev');
  assert.equal(g.state().rps, 15);
  process.env.JEV_MAX_RPS = '4';
  assert.equal(g.state().rps, 4, 'mudou o env: o portão enxerga na hora');
  process.env.JEV_MAX_RPS = '0';
  assert.equal(g.state().rps, 0, '0 desliga');
  process.env.JEV_MAX_RPS = 'abc';
  assert.equal(jevMaxRps(), 15);
  assert.equal(rateGateFor('fetch').state().rps, 0, 'outras lanes: sem portão por default');
});
