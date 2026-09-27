// Regressão do log de calibração do teto llm (fim de run): `getCalibration().rateLimitEvents` é um
// OBJETO `{llm, jev}` (governor.js) e a mensagem interpolava o objeto inteiro — "( [object Object]
// 429 nesta run)" em todo run com 429 (visto na run #26 do macmini, 2026-09-27). O teste congela o
// formato: a CONTAGEM de 429 da lane llm, nunca o objeto.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxEnv } from './helpers/env.js';

const SANDBOX = sandboxEnv({}, { homePrefix: 'nc-calib-log-' });
after(() => SANDBOX.restore());

const { initGovernor, stopGovernor, reportRateLimit } = await import('../src/governor.js');
const { persistLlmCalibration } = await import('../src/commands.js');
const { setLogSink } = await import('../src/util.js');

after(() => stopGovernor());

const GIB = 1024 ** 3;

test('persistLlmCalibration loga a CONTAGEM de 429 da lane llm (nunca [object Object])', () => {
  // Mesma geometria hermética do governor.aimd.test.js: memória/CPU/clock roteirizados.
  initGovernor({
    parallel: 32,
    profile: 'llm-only',
    readMem: () => ({ totalBytes: 32 * GIB, availableBytes: 20 * GIB }),
    readCpu: () => 80,
    now: () => 100_000,
    autoStart: false,
    ramMaxPct: 80,
    ramHysteresisPct: 10,
    ramFreeTargetPct: 20,
    cpuFreeTargetPct: 40,
    jevConcurrency: 8,
  });
  reportRateLimit(); // lane 32 -> 16 (teto aprendido)
  reportRateLimit(); // lane 16 -> 8 (abaixo do teto do perfil -> dirty, persiste)

  const lines = [];
  setLogSink(({ text }) => lines.push(String(text)));
  try {
    persistLlmCalibration();
  } finally {
    setLogSink(null);
  }

  const line = lines.find((l) => l.includes('calibração: teto llm'));
  assert.ok(line, `log de calibração ausente; capturado: ${JSON.stringify(lines)}`);
  assert.match(line, /\(\d+ 429 nesta run\)/, `contagem de 429 fora de formato: ${line}`);
  assert.ok(!line.includes('[object Object]'), `objeto vazou para o log: ${line}`);
});
