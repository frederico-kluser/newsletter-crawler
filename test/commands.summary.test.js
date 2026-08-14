// buildCliSummary (resumo periódico do CLI): a linha "resumo:" com fase atual, fila (frontier +
// em voo por tipo), artigos salvos na run, vereditos acumulados e erros recentes com timestamp.
// Função PURA (mesmo padrão do filterSeedSources/getSearchScope) — testada sem crawl.
// NC_HOME tmp + .env semeado vazio (padrão do commands.reextract.test.js; commands.js importa
// config/db no load, então o ambiente é neutralizado antes).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-summary-'));
writeFileSync(
  path.join(process.env.NC_HOME, '.env'),
  'OPENROUTER_API_KEY=\nDEEPSEEK_API_KEY=\nLLM_PROVIDER=\n',
);
const { buildCliSummary } = await import('../src/commands.js');
const { db } = await import('../src/db.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

test('resumo: fase, fila por tipo, salvos, vereditos e erros recentes com timestamp', () => {
  const line = buildCliSummary({
    progress: {
      stages: { fetch: 2, curadoria: 1 },
      counts: { salvos: 10, enriquecidos: 2, mantidosBlurb: 1 },
    },
    frontier: { pending: 3, in_progress: 1, done: 240, failed: 2 },
    inflight: 2,
    curating: 1,
    streaming: 3,
    // Shape do countVerifyForRun do db.js: [{ s, c }] agrupado por verify_status.
    verdicts: [
      { s: 'ok', c: 10 },
      { s: 'suspect', c: 2 },
      { s: 'junk', c: 0 },
      { s: '(pendente)', c: 3 },
    ],
    // Shape do ring de run-events: { at (ms), level, kind, detail }.
    errors: [
      { at: Date.parse('2026-08-14T15:42:01Z'), level: 'error', kind: 'job-error', detail: 'job falhou (article x)' },
      { at: Date.parse('2026-08-14T15:43:11Z'), level: 'warn', kind: 'timeout', detail: 'estourou o deadline' },
    ],
  });
  assert.ok(line.startsWith('resumo: '), 'prefijo estável p/ grep');
  assert.match(line, /fase fetch,curadoria/, 'fase atual (stages ativos)');
  assert.match(line, /fila 3p\/1a\/240d\/2x/, 'fila do frontier');
  assert.match(line, /voo artigos=2 curadoria=1 pós=3/, 'em voo POR TIPO (inflight/curating/streaming)');
  assert.match(line, /salvos \+12 \(\+1 blurb\)/, 'artigos salvos/enriquecidos na run');
  assert.match(line, /vereditos ok=10 suspeitos=2 junk=0 pend=3/, 'vereditos acumulados (labels PT)');
  assert.match(line, /erros 15:42:01 job falhou .*\| 15:43:11 estourou o deadline/, 'últimos erros com timestamp');
});

test('resumo: run recém-iniciada (sem nada) não quebra — fase — e sem vereditos/erros', () => {
  const line = buildCliSummary({
    progress: { stages: {}, counts: {} },
    frontier: {},
    verdicts: [],
    errors: [],
  });
  assert.match(line, /fase —/, 'sem fase ativa');
  assert.match(line, /fila 0p\/0a\/0d\/0x/, 'fronteira zerada');
  assert.match(line, /salvos \+0/, 'zero salvos');
  assert.ok(!line.includes('vereditos'), 'sem vereditos ainda');
  assert.ok(!line.includes('erros'), 'sem erros ainda');
});

test('resumo: sem progress (caller sem rastreador) também é seguro (fail-open)', () => {
  const line = buildCliSummary({ frontier: { pending: 1 } });
  assert.match(line, /fase —/, 'progress ausente vira fase —');
  assert.match(line, /fila 1p\/0a\/0d\/0x/, 'frontier informado é respeitado');
});
