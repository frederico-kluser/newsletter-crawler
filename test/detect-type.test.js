// Detecção de tipo da fonte: as funções PURAS (sinais + heurística) que embasam a decisão da IA e
// servem de fallback quando a IA não está disponível/falha. Sem rede/LLM. npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { gatherTypeSignals, heuristicType } from '../src/detect-type.js';

const issueLinks = (host, n, base = 430) =>
  Array.from({ length: n }, (_, i) => ({ url: `https://${host}/issues/${base - i}`, title: `Issue ${base - i}` }));

test('gatherTypeSignals: conta internos/externos e links que "parecem edição"', () => {
  const url = 'https://nodeweekly.com/issues';
  const links = [
    ...issueLinks('nodeweekly.com', 10),
    { url: 'https://nodeweekly.com/about', title: 'About' }, // interno, não-edição
    { url: 'https://example.com/article', title: 'externo' },
  ];
  const sig = gatherTypeSignals({ url, links, proseLen: 300 });
  assert.equal(sig.host, 'nodeweekly.com');
  assert.equal(sig.urlMatchesIndexPath, true);
  assert.equal(sig.internalLinks, 11);
  assert.equal(sig.externalLinks, 1);
  assert.equal(sig.issueLikeInternalLinks, 10);
  assert.equal(sig.proseChars, 300);
});

test('heuristicType: URL /issues + muitos links de edição -> index', () => {
  const sig = gatherTypeSignals({
    url: 'https://nodeweekly.com/issues',
    links: [...issueLinks('nodeweekly.com', 10), { url: 'https://ex.com/a', title: 'x' }],
    proseLen: 300,
  });
  assert.equal(heuristicType(sig), 'index');
});

test('heuristicType: página de links EXTERNOS (sem padrão de índice) -> listing', () => {
  const links = [
    ...Array.from({ length: 12 }, (_, i) => ({ url: `https://out${i}.com/post`, title: `p${i}` })),
    { url: 'https://links.example.com/about', title: 'About' },
    { url: 'https://links.example.com/rss', title: 'RSS' },
  ];
  const sig = gatherTypeSignals({ url: 'https://links.example.com/', links, proseLen: 200 });
  assert.equal(sig.externalLinks, 12);
  assert.equal(sig.issueLikeInternalLinks, 0);
  assert.equal(heuristicType(sig), 'listing');
});

test('heuristicType: index por VOLUME de edições internas mesmo sem padrão na URL', () => {
  const links = [
    ...Array.from({ length: 9 }, (_, i) => ({ url: `https://weekly.example.com/2026/${i + 1}`, title: `m${i}` })),
    { url: 'https://ex.com/a', title: 'externo' },
  ];
  const sig = gatherTypeSignals({ url: 'https://weekly.example.com/all', links, proseLen: 300 });
  assert.equal(sig.urlMatchesIndexPath, false);
  assert.equal(sig.issueLikeInternalLinks, 9);
  assert.equal(heuristicType(sig), 'index');
});

test('heuristicType: arquivo de blog (links próprios /p/slug, prosa) -> listing', () => {
  // Substack /archive: /archive casa o padrão de URL, mas os links são posts próprios (/p/slug),
  // que NÃO parecem edição -> não vira index.
  const links = Array.from({ length: 20 }, (_, i) => ({
    url: `https://blog.substack.com/p/post-${i}`, title: `Post ${i}`,
  }));
  const sig = gatherTypeSignals({ url: 'https://blog.substack.com/archive', links, proseLen: 800 });
  assert.equal(sig.urlMatchesIndexPath, true);
  assert.equal(sig.issueLikeInternalLinks, 0);
  assert.equal(heuristicType(sig), 'listing');
});

// ---- P2 no detect-type: o callJSON do classifyWithLLM precisa do `zod:` (regressão do revisor) ----
// O furo: detect-type.js:75 chamava callJSON SEM `zod:` e validava só no call site (detectZ.parse)
// — um shape inválido (ex.: {confidence:0.9} sem `type`) LANÇAVA sem retry e o detectSourceType
// caía na heurística (confidence 0.4). Com `zod: detectZ`, o shape inválido re-amostra dentro do
// callJSON (mesmo fluxo do llm.zod-retry.test.js) e a 2ª resposta recupera. Filho com
// --experimental-test-module-mocks (padrão do classify.incomplete.test.js): fetchSmart vira stub
// (ZERO rede) e o SDK do LLM é mockado com uma FILA de respostas.
const WIRE_CHILD_SOURCE = `import { mock } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2]; // raiz da worktree (passada pelo teste pai)
// Mesma instância de módulo que src/llm.js usa (import absoluto: o script vive fora da worktree,
// em /tmp, onde o bare specifier 'openai' não resolve).
const OpenAI = (await import(pathToFileURL(path.join(root, 'node_modules/openai/index.mjs')).href)).default;
const ncHome = mkdtempSync(path.join(tmpdir(), 'nc-detect-zod-'));
process.env.NC_HOME = ncHome;
process.on('exit', () => rmSync(ncHome, { recursive: true, force: true }));
// Env limpo: nada do shell pode vazar p/ a resolução (mesmo padrão dos outros testes).
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) delete process.env[k];
}
process.env.LLM_PROVIDER = 'deepseek';
process.env.DEEPSEEK_API_KEY = 'sk-ds-a';

// Sem rede: o módulo fetch.js vira stub (o detect-type só importa o fetchSmart dele).
mock.module(pathToFileURL(path.join(root, 'src/fetch.js')).href, {
  namedExports: {
    fetchSmart: async () => ({
      html: '<html><body>' +
        '<a href="https://nodeweekly.com/issues/430">Issue 430</a>' +
        '<a href="https://nodeweekly.com/issues/429">Issue 429</a>' +
        '<a href="https://nodeweekly.com/about">About</a>' +
        '</body></html>',
    }),
  },
});

const detect = await import(pathToFileURL(path.join(root, 'src/detect-type.js')).href);
// Silencia o log() do detectSourceType (stdout fica SÓ com o JSON de resultado) e captura os
// warns — a evidência do retry ("resposta fora do schema") vai junto no resultado.
const { setLogSink } = await import(pathToFileURL(path.join(root, 'src/util.js')).href);
const warns = [];
setLogSink((e) => warns.push(e.text));

// ---- mock do SDK (padrão do llm.zod-retry.test.js): 1ª resposta com shape INVÁLIDO ----
const calls = [];
const responses = [
  { confidence: 0.9 }, // sem \`type\` (o caso do revisor): shape inválido -> retry
  { type: 'index', confidence: 0.95, reason: 'página /issues com links de edições' },
];
mock.method(OpenAI.Chat.Completions.prototype, 'create', async function () {
  calls.push(1);
  return {
    model: 'deepseek-v4-flash',
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    choices: [{ message: { content: JSON.stringify(responses.shift() ?? {}) } }],
  };
});

let out = null;
try {
  const r = await detect.detectSourceType('https://nodeweekly.com/issues');
  if (r.type !== 'index' || r.source !== 'llm' || calls.length !== 2) {
    throw new Error('resultado inesperado (retry não recuperou): ' + JSON.stringify({ ...r, calls: calls.length }));
  }
  if (!warns.some((w) => w.includes('resposta fora do schema'))) {
    throw new Error('sem warn de shape inválido (zod: não aplicado?): ' + warns.join(' | '));
  }
  out = JSON.stringify({ type: r.type, source: r.source, calls: calls.length });
} catch (e) {
  process.stderr.write(String((e && e.stack) || e));
  process.exitCode = 1;
}
if (out !== null) process.stdout.write(out);
`;

test('detectSourceType: shape inválido na 1ª resposta LLM -> retry recupera (zod: no callJSON)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const scriptPath = path.join(os.tmpdir(), 'wire-detect-type-zod.mjs');
  writeFileSync(scriptPath, WIRE_CHILD_SOURCE, 'utf8');
  const child = spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', scriptPath, root],
    { encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(child.status, 0, `filho do wire test falhou: ${child.stderr || child.stdout || child.error}`);
  assert.ok(child.stdout.trim(), 'filho sem stdout');
  const out = JSON.parse(child.stdout);
  assert.equal(out.type, 'index', '2ª tentativa (shape válido) decidiu o tipo');
  assert.equal(out.source, 'llm', 'a IA decidiu (sem cair na heurística)');
  assert.equal(out.calls, 2, 'shape inválido re-amostrou 1x (retry do zod, não 1 chamada + heurística)');
  rmSync(scriptPath, { force: true });
});
