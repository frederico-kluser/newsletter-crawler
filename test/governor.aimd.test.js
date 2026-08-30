// Eval do controlador AIMD do governador, dirigido com leitor de memória e relógio
// ROTEIRIZADOS (nunca esgota RAM real): split por perfil, slew de partida do render,
// grow +1/tick, shrink multiplicativo sob pressão, escalada p/ fetch, dwell pós-shrink,
// freio de emergência (callback aos 30s) e backpressure de 429 na lane llm. npm test.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  initGovernor, stopGovernor, governorTick, getLane, jobsCapacity, stageWindow,
  reportRateLimit, setProfile, getTelemetry, getCalibration,
} from '../src/governor.js';

const GIB = 1024 ** 3;

// total 32 GiB + RAM_MAX_PCT 80 -> piso de MemAvailable = 6.4 GiB; growCut = 6.4 + 3.2 = 9.6 GiB.
// HERMÉTICO: o init() fixa ramMaxPct/ramHysteresisPct (os 80/10 do config.js) em vez de herdar o
// .env global do usuário (~/.newsletter-crawler/.env). Com RAM_MAX_PCT=90 (piso 3.2 / growCut
// 6.4) o EMA fica "ok" um tick a mais — render 5->6->7 em vez de 5->6 antes da pressão — e os
// asserts abaixo, calibrados para 80/10, quebram.
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
    // Pina a geometria do AIMD (piso/growCut) — determinístico independente do .env da máquina.
    ramMaxPct: 80,
    ramHysteresisPct: 10,
    ...opts,
  });
}

afterEach(() => stopGovernor());

test('init (perfil crawl, N=32): split llm/fetch e slew de partida do render', () => {
  const env = makeEnv({});
  init(env);
  assert.equal(getLane('llm').concurrency, 32, 'llm = N (máquina inteira na lane de API)');
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

test('429: lane llm halva e CALIBRA o teto — converge no limite aprendido (não oscila)', () => {
  const env = makeEnv({});
  init(env, { profile: 'llm-only' });
  assert.equal(getLane('llm').concurrency, 32);
  assert.equal(getCalibration().dirty, false, 'no teto do perfil: nada a persistir');
  reportRateLimit();
  assert.equal(getLane('llm').concurrency, 16, 'lane 32 -> 16');
  assert.equal(getCalibration().llmCap, 16, 'teto calibrado 16 (limite aprendido)');
  assert.equal(getCalibration().rateLimitEvents, 1);
  reportRateLimit();
  assert.equal(getLane('llm').concurrency, 8, 'lane 16 -> 8');
  assert.equal(getCalibration().llmCap, 8, 'teto calibrado 8');
  assert.equal(getCalibration().dirty, true, 'abaixo do teto do perfil -> persiste no fim do run');
  env.tick(120); // 2 minutos limpos (janelas de 10s)
  assert.equal(getLane('llm').concurrency, 8, 'NÃO recresce: 8 É o teto calibrado (convergência)');
  assert.equal(getCalibration().llmCap, 8, 'teto permanece calibrado');
});

test('llmCap persistido: lane parte do cap (clamp piso 3..perfil); setProfile não ressuscita', () => {
  const env = makeEnv({});
  init(env, { profile: 'crawl', llmCap: 4 });
  assert.equal(getLane('llm').concurrency, 4, 'cap 4 < alloc 32 -> lane parte em 4');
  assert.equal(getCalibration().llmCap, 4);
  env.tick(60);
  assert.equal(getLane('llm').concurrency, 4, 'sem 429, NÃO cresce além do cap calibrado');
  stopGovernor();
  init(env, { profile: 'crawl', llmCap: 999 });
  assert.equal(getLane('llm').concurrency, 32, 'cap 999 > alloc -> clamp ao teto do perfil');
  assert.equal(getCalibration().dirty, false, 'no teto do perfil: nada a persistir');
  reportRateLimit(); // 32 -> 16 (lane e teto)
  setProfile('llm-only'); // alloc llm-only = 32; o cap calibrado 16 sobrevive
  assert.equal(getLane('llm').concurrency, 16, 'setProfile não ressuscita o teto calibrado');
  assert.equal(getCalibration().dirty, true);
});

test('stageWindow: min(override>0, capacidade llm) e setProfile realoca', () => {
  const env = makeEnv({});
  init(env); // crawl: llm 32 (=N)
  assert.equal(stageWindow(0), 32, 'sem override: janela = lane llm');
  assert.equal(stageWindow(6), 6, 'override menor vale');
  assert.equal(stageWindow(100), 32, 'override maior não fura a lane');

  setProfile('llm-only');
  assert.equal(getLane('llm').concurrency, 32, 'llm-only: N inteiro p/ a lane llm');
  assert.equal(getLane('fetch').concurrency, 1);
  assert.equal(getLane('render').concurrency, 1);
});
