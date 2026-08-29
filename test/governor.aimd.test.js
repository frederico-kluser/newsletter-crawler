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

// total 32 GiB, RAM_FREE_TARGET_PCT 20 (default=100-80) -> alvo de RAM livre 20% = 6.4 GiB;
// histérese 10 -> só cresce acima de 30% livre (9.6 GiB). CPU injetada fixa em 80% livre
// (> alvo 40) para o teste não depender da carga real da máquina; os testes sinalizam pressão
// de CPU abaixando env.cpuFree.
function makeEnv({ totalGiB = 32, availGiB = 20, cpuFreeGiB = 80 } = {}) {
  const env = { now: 100_000, total: totalGiB * GIB, avail: availGiB * GIB };
  env.cpuFree = cpuFreeGiB;
  env.readMem = () => ({ totalBytes: env.total, availableBytes: env.avail });
  env.readCpu = () => env.cpuFree;
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
    ...opts,
  });
}

afterEach(() => stopGovernor());

test('init (perfil crawl, N=32): split llm/fetch e slew de partida do render', () => {
  const env = makeEnv({});
  init(env);
  assert.equal(getLane('llm').concurrency, 20, 'llm = ceil(N*0.6)');
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

test('pressão: shrink x0.5 no render até o piso, depois escalada p/ fetch; dwell segura o regrow', () => {
  const env = makeEnv({});
  init(env);
  env.tick(5); // render cresce até 5 com folga (62.5% livre > 30% grow-below)
  assert.equal(getLane('render').concurrency, 5);

  env.avail = 2 * GIB; // 6.25% livre < alvo 20% -> pressão assim que o EMA assenta (acima do freio 1.5)
  env.tick(7); // EMA entra em pressão (tick ~3); render 5 -> 2 -> 1 (piso); overTick>=5 escala p/ fetch
  assert.equal(getLane('render').concurrency, 1, 'pressão leva o render ao piso');
  assert.equal(getLane('fetch').concurrency, 4, 'pressão sustentada escala p/ fetch: 8 -> 4');

  env.avail = 20 * GIB; // alivia p/ 62.5% livre
  env.tick(4); // EMA recupera, mas o dwell (10s desde o último shrink) ainda segura o regrow
  assert.equal(getLane('render').concurrency, 1, 'dwell pós-shrink: ainda sem regrow');
  env.tick(7); // >10s do último shrink -> volta a 'ok' e recresce
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

test('CPU em HOLD: mesmo com RAM abundante, a pressão de CPU segura o crescimento', () => {
  const env = makeEnv({ availGiB: 20 }); // 62.5% RAM livre: folga de RAM de sobra
  init(env);
  env.tick(5);
  assert.equal(getLane('render').concurrency, 5, 'com CPU 80% ociosa, o render cresce livre');

  env.cpuFree = 45; // entre alvo 40 e alvo+histerese 50: HOLD — CPU não cresce nem encolhe
  env.tick(12); // EMA da CPU (50%) assenta em ~45 e entra na faixa de hold
  const plateau = getLane('render').concurrency;
  env.tick(4);
  assert.equal(getLane('render').concurrency, plateau, 'CPU em HOLD: o render para de crescer apesar da RAM livre');
  assert.equal(getTelemetry().cpu.freePct, 45);
  assert.equal(getTelemetry().ram.freeTargetPct, 20);
  assert.equal(getTelemetry().cpu.freeTargetPct, 40);

  env.cpuFree = 80; // CPU alivia acima do alvo + histerese -> volta a crescer
  env.tick(5);
  assert.ok(getLane('render').concurrency > plateau, 'CPU de volta acima do alvo: retoma o crescimento');
});

test('CPU sem sinal (null): não segura — o controlador decide só por RAM até o 2º sample', () => {
  const env = makeEnv({ availGiB: 20 });
  env.readCpu = () => null; // simula janela de CPU ainda não disponível (1º sample)
  init(env);
  env.tick(5);
  assert.equal(getLane('render').concurrency, 5, 'CPU null não bloqueia o growth guiado por RAM');
  assert.equal(getTelemetry().cpu.freePct, null);
});

test('stageWindow: min(override>0, capacidade llm) e setProfile realoca', () => {
  const env = makeEnv({});
  init(env); // crawl: llm 20 (ceil(N*0.6))
  assert.equal(stageWindow(0), 20, 'sem override: janela = lane llm');
  assert.equal(stageWindow(6), 6, 'override menor vale');
  assert.equal(stageWindow(100), 20, 'override maior não fura a lane');

  setProfile('llm-only');
  assert.equal(getLane('llm').concurrency, 32, 'llm-only: N inteiro p/ a lane llm');
  assert.equal(getLane('fetch').concurrency, 1);
  assert.equal(getLane('render').concurrency, 1);
});
