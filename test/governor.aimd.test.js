// Eval do controlador AIMD do governador, dirigido com leitor de memória e relógio
// ROTEIRIZADOS (nunca esgota RAM real): split por perfil, slew de partida do render,
// grow +1/tick, shrink multiplicativo sob pressão, escalada p/ fetch, dwell pós-shrink,
// freio de emergência (callback aos 30s) e backpressure de 429 na lane llm. npm test.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  initGovernor, stopGovernor, governorTick, getLane, jobsCapacity, stageWindow,
  reportRateLimit, setProfile, getTelemetry,
} from '../src/governor.js';

const GIB = 1024 ** 3;

// total 32 GiB + RAM_MAX_PCT 80 -> piso de MemAvailable = 6.4 GiB; growCut = 6.4 + 3.2 = 9.6 GiB.
function makeEnv({ totalGiB = 32, availGiB = 20 } = {}) {
  const env = { now: 100_000, total: totalGiB * GIB, avail: availGiB * GIB };
  env.readMem = () => ({ totalBytes: env.total, availableBytes: env.avail });
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
    now: env.clock,
    autoStart: false,
    ...opts,
  });
}

afterEach(() => stopGovernor());

test('init (perfil crawl, N=32): split llm/fetch e slew de partida do render', () => {
  const env = makeEnv({});
  init(env);
  assert.equal(getLane('llm').concurrency, 16, 'llm = ceil(N/2)');
  assert.equal(getLane('fetch').concurrency, 8, 'fetch = ceil(N/4)');
  assert.equal(getLane('render').concurrency, 2, 'render parte pequeno (slew), teto 8');
  assert.equal(jobsCapacity(), 10, 'jobs = fetch + render');
});

test('folga sustentada: grow +1/tick no render após 3 ticks bons', () => {
  const env = makeEnv({});
  init(env);
  env.tick(2);
  assert.equal(getLane('render').concurrency, 2, 'ainda sem 3 ticks bons');
  env.tick(3); // ticks 3..5: +1 por tick
  assert.equal(getLane('render').concurrency, 5);
  assert.equal(jobsCapacity(), 13);
});

test('pressão: shrink x0.5 no render, depois escalada p/ fetch; dwell segura o regrow', () => {
  const env = makeEnv({});
  init(env);
  env.tick(5); // render cresce até 5 com folga
  assert.equal(getLane('render').concurrency, 5);

  env.avail = 2 * GIB; // acima do freio (1.5 GiB), abaixo do piso (6.4 GiB) após o EMA assentar
  // t1: EMA 11 GiB (ainda "ok" — o EMA suaviza), t2: 6.5 (hold), t3: 4.25 -> pressão.
  env.tick(2);
  assert.equal(getLane('render').concurrency, 6, 'EMA suaviza: 1 grow antes da pressão chegar');
  env.tick(1);
  assert.equal(getLane('render').concurrency, 3, 'pressão: render 6 -> 3');
  env.tick(1);
  assert.equal(getLane('render').concurrency, 1, 'pressão: render 3 -> 1 (piso)');
  env.tick(3); // overTicks acumulando com render no piso (5º over-tick no total)
  assert.equal(getLane('fetch').concurrency, 4, 'pressão sustentada escala p/ fetch: 8 -> 4');

  env.avail = 20 * GIB; // alivia
  env.tick(3); // EMA recupera e entra em "ok", mas o dwell (10s desde o último shrink) segura
  assert.equal(getLane('render').concurrency, 1, 'dwell pós-shrink: ainda sem regrow');
  env.tick(7);
  assert.ok(getLane('fetch').concurrency > 4, 'passado o dwell, o fetch recresce +1/tick');
});

test('freio de emergência: render ao piso já; callback após 30s crítico', () => {
  const env = makeEnv({});
  let brakes = 0;
  init(env, { onEmergencyBrake: () => brakes++ });
  env.tick(5);
  assert.equal(getLane('render').concurrency, 5);

  env.avail = 1 * GIB; // abaixo de 1.5 GiB: crítico usa a leitura CRUA (sem esperar o EMA)
  env.tick(1);
  assert.equal(getLane('render').concurrency, 1, 'crítico corta admissões de render já');
  assert.equal(getTelemetry().ram.state, 'critical');
  assert.equal(brakes, 0);
  env.tick(30);
  assert.equal(brakes, 1, 'persistiu 30s -> recicla o browser 1x (e re-arma)');
});

test('429: lane llm halva e recupera +1 por janela limpa de 10s', () => {
  const env = makeEnv({});
  init(env, { profile: 'llm-only' });
  assert.equal(getLane('llm').concurrency, 32);
  reportRateLimit();
  assert.equal(getLane('llm').concurrency, 16);
  reportRateLimit();
  assert.equal(getLane('llm').concurrency, 8);
  env.tick(9);
  assert.equal(getLane('llm').concurrency, 8, 'janela de 10s ainda não fechou');
  env.tick(1);
  assert.equal(getLane('llm').concurrency, 9, '+1 após 10s sem 429');
  env.tick(10);
  assert.equal(getLane('llm').concurrency, 10, '+1 por janela de 10s (não por tick)');
});

test('stageWindow: min(override>0, capacidade llm) e setProfile realoca', () => {
  const env = makeEnv({});
  init(env); // crawl: llm 16
  assert.equal(stageWindow(0), 16, 'sem override: janela = lane llm');
  assert.equal(stageWindow(6), 6, 'override menor vale');
  assert.equal(stageWindow(100), 16, 'override maior não fura a lane');

  setProfile('llm-only');
  assert.equal(getLane('llm').concurrency, 32, 'llm-only: N inteiro p/ a lane llm');
  assert.equal(getLane('fetch').concurrency, 1);
  assert.equal(getLane('render').concurrency, 1);
});
