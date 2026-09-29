// Integração OFFLINE do motor da análise JEV: snapshot de fixture (servidor local), KV emulado e
// transporte falso roteado (Decisions API × KV × webhook) — zero rede externa, zero LLM pago.
// Cobre: run completa → payload JSON array no webhook com assinatura; guarda de injeção; 402 aborta.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { advanceRun, runView, startRun } from '../api/_lib/analyze.js';
import { jevDecide, JevHttpError } from '../api/_lib/jev.js';
import { signPayload } from '../api/_lib/dispatch.js';
import { env } from '../api/_lib/env.js';

// ---- fixtures ----

const ARTICLES = [
  { id: 1, source_id: 1, date_iso: '2026-09-01', kind: 'news', verify_status: 'ok', title: 'AI agents take over CI', title_pt: 'Agentes de IA na CI', summary_pt: 'Resumo um.', tags: { domain: ['devops'] } },
  { id: 2, source_id: 1, date_iso: '2026-09-02', kind: 'news', verify_status: 'ok', title: 'Cooking pasta better', title_pt: 'Macarrão melhor', summary_pt: 'Resumo dois.', tags: {} },
  { id: 3, source_id: 2, date_iso: '2026-09-03', kind: 'news', verify_status: 'ok', title: 'MCP servers in practice', title_pt: 'MCP na prática', summary_pt: 'Resumo três.', tags: {} },
  { id: 4, source_id: 2, date_iso: '2026-09-04', kind: 'news', verify_status: 'junk', title: 'spam', title_pt: 'spam', summary_pt: 'x', tags: {} },
  { id: 5, source_id: 1, date_iso: '2026-09-05', kind: 'news', verify_status: 'ok', title: 'Gardening tips', title_pt: 'Dicas de jardinagem', summary_pt: 'Resumo cinco.', tags: {} },
];
const META = { sources: [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }], toolContentTypes: [] };

function makeKvFake() {
  const store = new Map();
  const lists = new Map();
  return async ({ body }) => {
    const parsed = JSON.parse(body);
    const pipeline = Array.isArray(parsed[0]);
    const cmds = pipeline ? parsed : [parsed];
    const results = cmds.map(([op, ...args]) => {
      switch (op) {
        case 'GET':
          return { result: store.has(args[0]) ? store.get(args[0]) : null };
        case 'SET':
          store.set(args[0], args[1]);
          return { result: 'OK' };
        case 'LPUSH': {
          const l = lists.get(args[0]) || [];
          l.unshift(args[1]);
          lists.set(args[0], l);
          return { result: l.length };
        }
        case 'LRANGE': {
          const l = lists.get(args[0]) || [];
          return { result: l.slice(Number(args[1]), Number(args[2]) + 1) };
        }
        case 'LTRIM': {
          const l = (lists.get(args[0]) || []).slice(Number(args[1]), Number(args[2]) + 1);
          lists.set(args[0], l);
          return { result: 'OK' };
        }
        default:
          return { error: `unsupported ${op}` };
      }
    });
    return {
      statusCode: 200,
      body: JSON.stringify(pipeline ? { result: results } : results[0]),
      headers: {},
    };
  };
}

function makeJevFake({ injectionP = 0.02, httpStatus = 200, bodyOverride } = {}) {
  return async ({ body }) => {
    if (httpStatus !== 200) return { statusCode: httpStatus, body: JSON.stringify({ error: 'no credits' }), headers: {} };
    const req = JSON.parse(body);
    const answers = {};
    for (const id of Object.keys(req.questions)) {
      if (id === 'injection') {
        answers[id] = { type: 'noul', noul: injectionP };
        continue;
      }
      const n = Number(id.slice(1));
      const article = req.state.articles[n - 1];
      const hit = /AI|MCP/i.test(article.title);
      answers[id] = { type: 'noul', noul: hit ? 0.92 : 0.06 };
    }
    return {
      statusCode: 200,
      body:
        bodyOverride ||
        JSON.stringify({
          id: 'gen-dec-1',
          model: 'typesafe/jev-1.13-20260917',
          provider: 'TypeSafe',
          answers,
          usage: { input_tokens: 1200, output_tokens: 0, cost: 0.00005 },
        }),
      headers: {},
    };
  };
}

function makeWebhookFake(log) {
  return async ({ url, method, headers, body }) => {
    log.push({ url, method, headers, body });
    return { statusCode: 200, body: 'ok', headers: {} };
  };
}

function makeRouter({ kv, jev, webhook, kvUrl, jevUrl, webhookUrl }) {
  return async (opts) => {
    if (opts.url === kvUrl) return kv(opts);
    if (opts.url === jevUrl) return jev(opts);
    if (opts.url.startsWith(webhookUrl)) return webhook(opts);
    throw new Error(`transporte sem rota: ${opts.url}`);
  };
}

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const snapshotServer = (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/data/meta.json') return res.end(JSON.stringify(META));
  if (req.url === '/data/articles.json') return res.end(JSON.stringify(ARTICLES));
  res.statusCode = 404;
  res.end('{}');
};

test('run completa: escopo → batches Jev → separadas (p ≥ limiar) → JSON array assinado no webhook', async () => {
  await withServer(snapshotServer, async (base) => {
    const kv = makeKvFake();
    const webhookLog = [];
    const jevUrl = 'http://jev.test/api/alpha/decisions';
    const kvUrl = 'http://kv.test/rest';
    const webhookUrl = 'https://hooks.exemplo.com/x';
    const transport = makeRouter({ kv, jev: makeJevFake(), webhook: makeWebhookFake(webhookLog), kvUrl, jevUrl, webhookUrl });

    await withEnv(
      {
        NC_DATA_BASE_URL: base,
        OPENROUTER_API_KEY: 'sk-test',
        KV_REST_API_URL: kvUrl,
        KV_REST_API_TOKEN: 'tok',
        WEBHOOK_SECRET: 'whsec',
        NC_JEV_BASE_URL: jevUrl,
        NC_JEV_BATCH: '2',
        NC_JEV_CONCURRENCY: '2',
      },
      async () => {
        const config = { input: 'AI e MCP', from: '', to: '', sourceIds: [], kind: 'all', threshold: 0.5, webhookUrl };
        const run = await startRun({ env, trigger: 'manual', config, transport });
        assert.equal(run.scope.total, 4, 'junk fica fora do escopo');
        assert.equal(run.scope.batchSize, 2, 'NC_JEV_BATCH=2 fixa o lote');
        assert.equal(run.config.batchSize, 2, 'o lote fica registado na config da run');
        assert.equal(run.progress.total, 2, '4 artigos em batches de 2 → 2 batches');

        const done = await advanceRun(run.id, { env, budgetMs: 60000, transport });
        assert.equal(done.status, 'done');
        assert.equal(done.progress.processed, 4);
        assert.equal(done.matches.length, 2, 'só os títulos com AI/MCP passam do limiar 0.5');
        assert.deepEqual(done.matches.map((m) => m.id), [3, 1], 'ordem data DESC');
        assert.equal(done.usage.requests, 2, 'um request Jev por batch');
        assert.ok(done.usage.cost > 0);
        assert.equal(done.model, 'typesafe/jev-1.13-20260917');

        // dispatch: UM POST com o JSON array puro + headers de run + assinatura HMAC
        assert.equal(webhookLog.length, 1);
        const call = webhookLog[0];
        assert.equal(call.method, 'POST');
        const payload = JSON.parse(call.body);
        assert.ok(Array.isArray(payload));
        assert.equal(payload.length, 2);
        const item = payload[0];
        assert.deepEqual(item.source, { id: 2, name: 'Beta' });
        assert.equal(item.summary_pt, 'Resumo três.');
        assert.equal(item.jev.decision, 'yes');
        assert.ok(item.jev.p >= 0.5);
        assert.ok(!('snippet' in item) && !('content' in item), 'sem corpo no payload');
        assert.equal(call.headers['x-nc-signature'], signPayload(call.body, 'whsec'));
        assert.equal(call.headers['x-nc-run-id'], done.id);
        assert.equal(call.headers['x-nc-trigger'], 'manual');
        assert.equal(call.headers['x-nc-count'], '2');
        assert.equal(done.dispatch.ok, true);

        const view = runView(done);
        assert.equal(view.matchesTotal, 2);
      },
    );
  });
});

test('guarda de injeção: lote sinalizado não dispara e fica contado', async () => {
  await withServer(snapshotServer, async (base) => {
    const kv = makeKvFake();
    const webhookLog = [];
    const jevUrl = 'http://jev.test/api/alpha/decisions';
    const kvUrl = 'http://kv.test/rest';
    const webhookUrl = 'https://hooks.exemplo.com/x';
    const transport = makeRouter({
      kv,
      jev: makeJevFake({ injectionP: 0.9 }),
      webhook: makeWebhookFake(webhookLog),
      kvUrl,
      jevUrl,
      webhookUrl,
    });
    await withEnv(
      {
        NC_DATA_BASE_URL: base,
        OPENROUTER_API_KEY: 'sk-test',
        KV_REST_API_URL: kvUrl,
        KV_REST_API_TOKEN: 'tok',
        NC_JEV_BASE_URL: jevUrl,
        NC_JEV_BATCH: '4',
      },
      async () => {
        const config = { input: 'AI e MCP', from: '', to: '', sourceIds: [], kind: 'all', threshold: 0.5, webhookUrl };
        const run = await startRun({ env, trigger: 'cron', config, transport });
        const done = await advanceRun(run.id, { env, budgetMs: 60000, transport });
        assert.equal(done.status, 'done');
        assert.equal(done.matches.length, 0);
        assert.equal(done.injectionFlagged, 4);
        assert.equal(webhookLog.length, 0, 'sem correspondências → nada disparado');
        assert.equal(done.dispatch.skipped, 'no-matches');
      },
    );
  });
});

test('Jev HTTP 402 (sem créditos) aborta a run com status error', async () => {
  await withServer(snapshotServer, async (base) => {
    const kv = makeKvFake();
    const jevUrl = 'http://jev.test/api/alpha/decisions';
    const kvUrl = 'http://kv.test/rest';
    const webhookUrl = 'https://hooks.exemplo.com/x';
    const transport = makeRouter({
      kv,
      jev: makeJevFake({ httpStatus: 402 }),
      webhook: makeWebhookFake([]),
      kvUrl,
      jevUrl,
      webhookUrl,
    });
    await withEnv(
      {
        NC_DATA_BASE_URL: base,
        OPENROUTER_API_KEY: 'sk-test',
        KV_REST_API_URL: kvUrl,
        KV_REST_API_TOKEN: 'tok',
        NC_JEV_BASE_URL: jevUrl,
      },
      async () => {
        const config = { input: 'AI', from: '', to: '', sourceIds: [], kind: 'all', threshold: 0.5, webhookUrl };
        const run = await startRun({ env, trigger: 'manual', config, transport });
        const done = await advanceRun(run.id, { env, budgetMs: 60000, transport });
        assert.equal(done.status, 'error');
        assert.match(done.error, /402/);
        assert.equal(done.matches.length, 0);
      },
    );
  });
});

test('jevDecide: 429 com Retry-After é repetido; 400 é terminal; resposta inválida cai em onDrop', async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) return { statusCode: 429, body: 'rate limited', headers: { 'retry-after': '0.01' } };
    return {
      statusCode: 200,
      body: JSON.stringify({
        model: 'typesafe/jev-1.13-20260917',
        answers: { q1: { type: 'noul', noul: 0.7 }, injection: { type: 'noul', noul: 0.01 } },
        usage: { input_tokens: 10, output_tokens: 0, cost: 0.0001 },
      }),
      headers: {},
    };
  };
  const questions = { q1: { type: 'noul', instructions: 'ok?', criteria: { true: 'y', false: 'n' } }, injection: { type: 'noul', instructions: 'inj?', criteria: { true: 'y', false: 'n' } } };
  const res = await jevDecide({ state: { a: 1 }, questions, model: 'typesafe/jev-1.13', apiKey: 'k', baseUrl: 'http://jev.test/api/alpha/decisions', transport: flaky });
  assert.equal(calls, 2, 'o 429 repete');
  assert.equal(res.answers.q1.noul, 0.7);
  assert.equal(res.usage.cost, 0.0001);

  await assert.rejects(
    () =>
      jevDecide({
        state: { a: 1 },
        questions,
        model: 'typesafe/jev-1.13',
        apiKey: 'k',
        baseUrl: 'http://jev.test/api/alpha/decisions',
        transport: async () => ({ statusCode: 400, body: 'bad request', headers: {} }),
      }),
    (err) => err instanceof JevHttpError && err.status === 400,
    '400 é terminal',
  );
});
