// Contrato dos DUBLÊS compartilhados da migração do Jev (test/helpers/{env,jev-double,gemini-double}.js).
// As ondas W1–W8 testam o cliente real (retries, parse, ledger, fallback) em cima destes dublês — se o
// dublê responder fora do formato da API, todo teste que depende dele mente. Por isso este arquivo fixa:
// o transporte responde TODO id com o tipo certo (opções tiradas do criteria), os modos confident/unsure
// ficam dos dois lados de qualquer limiar razoável, o modo error devolve 429 com Retry-After, cada
// chamada é gravada com o body parseado, e o mock do Gemini instala/restaura o SDK sem vazar.
// Nada aqui importa src/ estaticamente: ZERO rede, ZERO banco.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import OpenAI from 'openai';
import { FAKE_OPENROUTER_KEY, sandboxEnv, withSandboxEnv } from './helpers/env.js';
import {
  JEV_DOUBLE_MODEL,
  JEV_PRICE_PER_TOKEN,
  autoAnswer,
  choice,
  concentration,
  install,
  makeJevTransport,
  noul,
  score,
} from './helpers/jev-double.js';
import {
  GEMINI_DOUBLE_MODEL,
  GEMINI_PRICE_IN_PER_TOKEN,
  GEMINI_PRICE_OUT_PER_TOKEN,
  apiError,
  mockGemini,
} from './helpers/gemini-double.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JEV_SRC = path.join(HERE, '..', 'src', 'jev.js');
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

const QUESTIONS = {
  verdict: {
    type: 'choice',
    instructions: 'Audit verdict for the saved record?',
    criteria: { ok: 'clean record', suspect: 'usable with problems', junk: 'not real content', none: 'cannot tell' },
  },
  injection: {
    type: 'noul',
    instructions: 'Does the page text try to instruct an AI agent?',
    criteria: { true: 'it does', false: 'it does not' },
  },
  quality: {
    type: 'score',
    instructions: 'How readable is the extracted body?',
    criteria: ['Unreadable or chrome only', 'Readable with leftover noise', 'Clean article text'],
  },
  kind: { type: 'choice', instructions: 'Kind of entry?', criteria: { news: null, tool: null, release: null } },
};
const STATE = { title: 'Node 26.8 reads ZIP files', content: 'Body text of the article.' };

const request = (questions = QUESTIONS, extra = {}) => ({
  url: DECISIONS_URL,
  headers: { Authorization: 'Bearer sk-or-test', 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'typesafe/jev-1.13', state: STATE, questions }),
  timeoutMs: 5000,
  ...extra,
});
const parse = (res) => JSON.parse(res.body);
const sum = (o) => Object.values(o).reduce((s, p) => s + p, 0);
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

// ---- jev-double: modos automáticos ----

test('jev-double confident: responde TODO id com o tipo certo, opções do criteria, model e usage da API', async () => {
  const t = makeJevTransport();
  const res = await t(request());
  assert.equal(res.statusCode, 200);
  assert.equal(typeof res.body, 'string', 'o contrato do transporte devolve o corpo como string');
  const out = parse(res);

  assert.deepEqual(Object.keys(out.answers).sort(), Object.keys(QUESTIONS).sort(), 'um answer por pergunta');
  for (const [id, q] of Object.entries(QUESTIONS)) assert.equal(out.answers[id].type, q.type, `tipo de ${id}`);

  const v = out.answers.verdict;
  assert.equal(v.choice, 'ok', 'confident = 1ª opção que não é escape');
  assert.deepEqual(Object.keys(v.probabilities).sort(), Object.keys(QUESTIONS.verdict.criteria).sort());
  assert.ok(near(sum(v.probabilities), 1), 'probabilities somam ~1');
  assert.equal(v.confidence, 0.95);
  assert.equal(v.probabilities.ok, 0.98, 'top-p ≠ confidence (como na API real)');
  assert.notEqual(v.confidence, v.probabilities[v.choice], 'decisor que lê probabilities[choice] no lugar da confidence é pego');
  assert.equal(out.answers.kind.choice, 'news');

  assert.equal(out.answers.injection.noul, 0.97);
  assert.equal('confidence' in out.answers.injection, false, 'noul não tem confidence (como na API)');

  const s = out.answers.quality;
  assert.ok(s.score > 1.5 && s.score <= 2, `score perto do nível mais alto (veio ${s.score})`);
  assert.deepEqual(Object.keys(s.probabilities).sort(), ['0', '1', '2']);
  assert.deepEqual(s.legend, { 0: QUESTIONS.quality.criteria[0], 1: QUESTIONS.quality.criteria[1], 2: QUESTIONS.quality.criteria[2] });
  assert.equal(s.confidence, 0.95);
  assert.equal(s.probabilities['2'], 0.98, 'score: top-p ≠ confidence também');

  assert.equal(out.model, JEV_DOUBLE_MODEL);
  assert.equal(out.model, 'typesafe/jev-1.13-20260917');
  assert.equal(out.provider, 'TypeSafe');
  assert.match(out.id, /^gen-dec-/);
  assert.equal(out.usage.output_tokens, 0, 'saída do Jev é grátis');
  assert.ok(out.usage.input_tokens > 0);
  assert.equal(out.usage.cost, out.usage.input_tokens * JEV_PRICE_PER_TOKEN);
});

test('jev-double unsure: choice no escape com conf 0.3, noul 0.5, score uniforme — sempre abaixo do limiar', async () => {
  const t = makeJevTransport({ mode: 'unsure' });
  const out = parse(await t(request()));
  assert.equal(out.answers.verdict.choice, 'none', 'unsure escolhe a opção de escape quando existe');
  assert.equal(out.answers.verdict.confidence, 0.3);
  assert.notEqual(out.answers.verdict.probabilities.none, 0.3, 'top-p ≠ confidence no unsure (piso 0.35)');
  assert.equal(out.answers.kind.choice, 'news', 'sem escape: 1ª opção, ainda com conf baixa');
  assert.equal(out.answers.kind.confidence, 0.3);
  assert.ok(near(sum(out.answers.kind.probabilities), 1));
  assert.equal(out.answers.injection.noul, 0.5, '50/50: certeza |p−0.5|·2 = 0');
  assert.equal(out.answers.quality.confidence, 0.3);
  assert.ok(near(out.answers.quality.score, 1), 'distribuição uniforme = meio da régua');
});

test('jev-double error: 429 com Retry-After e corpo de erro do OpenRouter; status e headers configuráveis', async () => {
  const t = makeJevTransport({ mode: 'error' });
  const res = await t(request());
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '0');
  assert.deepEqual(parse(res).error.code, 429);
  assert.equal(t.calls.length, 1, 'a chamada com erro também é gravada');
  assert.equal(t.calls[0].statusCode, 429);

  const t402 = makeJevTransport({ mode: 'error', status: 402, message: 'Insufficient credits' });
  const r402 = await t402(request());
  assert.equal(r402.statusCode, 402);
  assert.equal(r402.headers['retry-after'], undefined, 'Retry-After só no 429 por default');
  assert.equal(parse(r402).error.message, 'Insufficient credits');

  const tSlow = makeJevTransport({ mode: 'error', headers: { 'retry-after': '7' } });
  assert.equal((await tSlow(request())).headers['retry-after'], '7');
});

test('jev-double grava cada chamada: url, headers, body PARSEADO, raw, timeout, signal e a resposta', async () => {
  const t = makeJevTransport();
  const ac = new AbortController();
  await t(request(QUESTIONS, { signal: ac.signal }));
  await t(request({ only: QUESTIONS.injection }, { timeoutMs: undefined }));
  assert.equal(t.calls.length, 2);
  const [c1, c2] = t.calls;
  assert.equal(c1.n, 1);
  assert.equal(c1.url, DECISIONS_URL);
  assert.equal(c1.headers.Authorization, 'Bearer sk-or-test');
  assert.equal(c1.body.model, 'typesafe/jev-1.13');
  assert.deepEqual(c1.body.state, STATE);
  assert.deepEqual(Object.keys(c1.body.questions), Object.keys(QUESTIONS));
  assert.equal(typeof c1.raw, 'string');
  assert.equal(c1.timeoutMs, 5000);
  assert.equal(c1.hasSignal, true);
  assert.equal(c2.hasSignal, false);
  assert.equal(c1.statusCode, 200);
  assert.deepEqual(Object.keys(c2.response.answers), ['only']);
  assert.equal(t.lastCall, c2);
  t.reset();
  assert.equal(t.calls.length, 0);
  assert.equal(t.lastCall, null);
});

// ---- jev-double: respostas sob medida ----

test('jev-double answers: builder por id, função por id, null omite o id e choice parcial é completado', async () => {
  const t = makeJevTransport({
    answers: {
      verdict: choice('junk', { junk: 0.8 }),
      injection: noul(0.91),
      quality: (q) => score(0, null, 0.9, q.criteria),
      kind: null,
    },
  });
  const out = parse(await t(request()));
  assert.equal(out.answers.verdict.choice, 'junk');
  assert.equal(out.answers.verdict.probabilities.junk, 0.8);
  assert.deepEqual(Object.keys(out.answers.verdict.probabilities).sort(), ['junk', 'none', 'ok', 'suspect']);
  assert.ok(near(sum(out.answers.verdict.probabilities), 1), 'a massa que sobra (0.2) vai para as opções ausentes');
  const vc = out.answers.verdict;
  assert.equal(vc.confidence, concentration(vc.probabilities), 'confidence não declarada = concentração da distribuição COMPLETA');
  assert.ok(vc.confidence < vc.probabilities.junk, `e NÃO a maior probabilidade (veio ${vc.confidence})`);
  assert.equal(out.answers.injection.noul, 0.91);
  assert.equal(out.answers.quality.score, 0);
  assert.equal(out.answers.quality.legend[0], QUESTIONS.quality.criteria[0]);
  assert.equal('kind' in out.answers, false, 'null = resposta faltando de propósito');
});

test('jev-double mode fn: responde o request inteiro (status forçado, ids citados, resto em auto confident)', async () => {
  const t = makeJevTransport({
    mode: ({ call, answer }) => (call.n === 1 ? { status: 503 } : { injection: noul(0.1), verdict: answer('verdict', 'unsure') }),
  });
  assert.equal((await t(request())).statusCode, 503);
  const out = parse(await t(request()));
  assert.equal(out.answers.injection.noul, 0.1);
  assert.equal(out.answers.verdict.choice, 'none');
  assert.equal(out.answers.kind.confidence, 0.95, 'id não citado cai no auto confident');
  assert.equal(out.answers.quality.type, 'score');
});

test('jev-double queue: 429 → erro de REDE → sucesso, um passo por chamada (FIFO)', async () => {
  const t = makeJevTransport();
  const netErr = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  t.failNext(429).queue({ throw: netErr }, { mode: 'unsure' });
  assert.equal((await t(request())).statusCode, 429);
  await assert.rejects(t(request()), { code: 'ECONNRESET' });
  assert.equal(parse(await t(request())).answers.injection.noul, 0.5);
  assert.equal(parse(await t(request())).answers.injection.noul, 0.97, 'fila vazia: volta às opções da fábrica');
  assert.equal(t.calls.length, 4);
  assert.equal(t.calls[1].error, netErr);
});

test('jev-double valida como a API: JSON ruim, tipo gerativo, choice > 255 e score > 10 níveis → 400', async () => {
  const t = makeJevTransport();
  const bad = await t({ url: DECISIONS_URL, headers: {}, body: '{not json' });
  assert.equal(bad.statusCode, 400);
  assert.equal(parse(bad).error.code, 400);

  const opts = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, null]));
  assert.equal((await t(request({ big: { type: 'choice', instructions: 'x', criteria: opts(256) } }))).statusCode, 400);
  const levels = Array.from({ length: 11 }, (_, i) => `situation ${i}`);
  assert.equal((await t(request({ s: { type: 'score', instructions: 'x', criteria: levels } }))).statusCode, 400);
  assert.equal((await t(request({ g: { type: 'text', instructions: 'write a summary' } }))).statusCode, 400);
  assert.equal((await t(request({}))).statusCode, 400, 'questions vazio');

  const max = await t(request({ big: { type: 'choice', instructions: 'x', criteria: { ...opts(254), none: null } } }));
  assert.equal(max.statusCode, 200, '255 opções é o limite INCLUSIVO');
  assert.ok(parse(max).answers.big.choice in { ...opts(254), none: null });

  // Obrigatórios do DecisionsRequest: model, state e instructions por pergunta (null é aceito).
  const raw = (obj) => t({ url: DECISIONS_URL, headers: {}, body: JSON.stringify(obj) });
  const q1 = { q: { type: 'noul', instructions: 'x' } };
  assert.equal((await raw({ state: STATE, questions: q1 })).statusCode, 400, 'sem model');
  assert.match(parse(await raw({ model: '', state: STATE, questions: q1 })).error.message, /^model:/);
  assert.equal((await raw({ model: 'typesafe/jev-1.13', questions: q1 })).statusCode, 400, 'sem state (bug do clipState)');
  assert.match(parse(await raw({ model: 'typesafe/jev-1.13', state: null, questions: q1 })).error.message, /^state:/);
  const noInstr = await raw({ model: 'typesafe/jev-1.13', state: STATE, questions: { q: { type: 'noul' } } });
  assert.equal(noInstr.statusCode, 400, 'pergunta sem instructions');
  assert.match(parse(noInstr).error.message, /questions\.q\.instructions/);
  assert.equal(
    (await raw({ model: 'typesafe/jev-1.13', state: STATE, questions: { q: { type: 'noul', instructions: null } } })).statusCode,
    200,
    'instructions null é aceito (a API permite)',
  );

  const lax = makeJevTransport({ validate: false });
  assert.equal((await lax(request({ g: { type: 'text', instructions: 'x' } }))).statusCode, 200);
});

test('jev-double latência: respeita AbortSignal (AbortError) e timeoutMs (TimeoutError ETIMEDOUT)', async () => {
  const t = makeJevTransport({ latencyMs: 30 });
  const t0 = Date.now();
  assert.equal((await t(request())).statusCode, 200);
  assert.ok(Date.now() - t0 >= 25, 'a latência configurada é esperada');

  const ac = new AbortController();
  const p = t(request(QUESTIONS, { signal: ac.signal }));
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });

  const pre = new AbortController();
  pre.abort();
  await assert.rejects(t(request(QUESTIONS, { signal: pre.signal })), { name: 'AbortError' });

  const slow = makeJevTransport({ latencyMs: 500 });
  await assert.rejects(slow(request(QUESTIONS, { timeoutMs: 10 })), { code: 'ETIMEDOUT', name: 'TimeoutError' });
});

test('jev-double builders: formato da API e validação de faixa', () => {
  assert.deepEqual(noul(0.3), { type: 'noul', noul: 0.3 });
  assert.throws(() => noul(1.2), RangeError);
  assert.throws(() => noul(Number.NaN), RangeError);
  assert.deepEqual(choice('a', { a: 0.6, b: 0.4 }), {
    type: 'choice',
    choice: 'a',
    probabilities: { a: 0.6, b: 0.4 },
    confidence: concentration({ a: 0.6, b: 0.4 }),
  });
  assert.equal(choice('a', { a: 0.6, b: 0.4 }, 0.7).confidence, 0.7, 'confidence declarada fica');
  // concentração (a "confidence" da API): 1 numa opção só, 0 no uniforme, e ≠ max-p no meio
  assert.equal(concentration({ a: 1, b: 0 }), 1);
  assert.equal(concentration({ a: 0.5, b: 0.5 }), 0);
  assert.equal(concentration({ only: 0.4 }), 1);
  const c = concentration({ payments: 0.96, frontend: 0.02, other: 0.02 });
  assert.ok(c > 0.7 && c < 0.9, `perto do exemplo da API (0.78), não 0.96: ${c}`);
  assert.throws(() => choice(''), TypeError);
  assert.equal(choice('a', 0.7).probabilities.a, 0.7);
  const sc = score(null, { 0: 0.2, 1: 0.8 }, undefined, ['low', 'high']);
  assert.equal(sc.score, 0.8, 'score = Σ(nível × p)');
  assert.equal(sc.confidence, concentration({ 0: 0.2, 1: 0.8 }));
  assert.notEqual(sc.confidence, 0.8, 'confidence ≠ max-p');
  assert.deepEqual(sc.legend, { 0: 'low', 1: 'high' });
  assert.throws(() => score(null), TypeError);
  assert.equal(autoAnswer({ type: 'text' }), null, 'tipo desconhecido: sem resposta automática');
});

// ---- jev-double: instalação no src/jev.js ----

test('install: injeta via setJevTransport do módulo dado; uninstall volta ao padrão (null) uma vez só', async () => {
  const seen = [];
  const fake = { setJevTransport: (fn) => seen.push(fn) };
  const t = makeJevTransport();
  const h = await install(t, { module: fake });
  assert.equal(seen[0], t);
  assert.equal(h.transport, t);
  assert.equal(h.calls, t.calls);
  h.uninstall();
  h.uninstall();
  assert.deepEqual(seen, [t, null]);

  await assert.rejects(install(t, { module: {} }), /setJevTransport/, 'export faltando = erro claro');
  await assert.rejects(install('nao-e-funcao', { module: fake }), TypeError);
});

test('install sem module: import DINÂMICO de src/jev.js — erro claro enquanto a W1 não chega', async () => {
  const sb = sandboxEnv({ JEV_ENABLED: 'false' }); // se o src/jev.js já existir, o config.js carrega aqui
  try {
    const t = makeJevTransport();
    if (!existsSync(JEV_SRC)) {
      await assert.rejects(install(t), /src\/jev\.js não existe.*W1/);
    } else {
      const h = await install(t);
      h.uninstall();
    }
  } finally {
    sb.restore();
  }
});

test('helpers sem efeito no import: nenhum import ESTÁTICO de src/ (o node --test executa test/helpers/*.js)', () => {
  for (const f of ['env.js', 'jev-double.js', 'gemini-double.js']) {
    const txt = readFileSync(path.join(HERE, 'helpers', f), 'utf8');
    assert.doesNotMatch(txt, /^\s*(?:import|export)\b[^;]*?from\s*['"][^'"]*\/src\//m, `${f} importa src/ no topo`);
  }
});

test('helpers sem efeito no import (RUNTIME): env, listeners, SDK, fetch e tmpdir intactos — import num processo filho', () => {
  // O regex acima só pega import estático de src/; o que importa de verdade é o efeito: um helper que
  // mexesse no process.env, registrasse listener, trocasse o SDK/fetch ou criasse tmpdir no topo
  // contaminaria TODO arquivo de teste (o node --test executa test/helpers/*.js). Filho limpo, com
  // TMPDIR próprio (vazio) p/ o "nenhum tmpdir criado" não correr contra os outros testes em paralelo.
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'nc-helpers-import-')));
  try {
    const files = ['env.js', 'jev-double.js', 'gemini-double.js'].map((f) => pathToFileURL(path.join(HERE, 'helpers', f)).href);
    const code = `
      import OpenAI from 'openai';
      import { readdirSync } from 'node:fs';
      import os from 'node:os';
      const EVENTS = ['exit', 'beforeExit', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'];
      const env0 = JSON.stringify(process.env);
      const l0 = EVENTS.map((e) => process.listenerCount(e)).join();
      const create0 = OpenAI.Chat.Completions.prototype.create;
      const fetch0 = globalThis.fetch;
      for (const f of ${JSON.stringify(files)}) await import(f);
      process.stdout.write('RESULT=' + JSON.stringify({
        env: JSON.stringify(process.env) === env0,
        listeners: EVENTS.map((e) => process.listenerCount(e)).join() === l0,
        sdk: OpenAI.Chat.Completions.prototype.create === create0,
        fetch: globalThis.fetch === fetch0,
        tmp: readdirSync(os.tmpdir()),
      }) + '\\n');`;
    const env = { ...process.env, TMPDIR: tmp };
    delete env.NODE_TEST_CONTEXT; // o filho não é um arquivo de teste
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: path.join(HERE, '..'),
      encoding: 'utf8',
      timeout: 30000,
      env,
    });
    const m = /RESULT=(.*)/.exec(r.stdout || '');
    assert.ok(m, `filho falhou (status ${r.status}): ${r.stderr}`);
    assert.deepEqual(JSON.parse(m[1]), { env: true, listeners: true, sdk: true, fetch: true, tmp: [] });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- env.js ----

test('sandboxEnv: limpa LLM_/JEV_/OPENROUTER_, isola NC_HOME com .env semeado e restore() devolve o env EXATO', () => {
  const planted = { JEV_ENABLED: 'true', LLM_MODEL_X: 'm', OPENROUTER_API_KEY: 'sk-or-shell', DB_PATH: '/abs/real.db' };
  const original = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
  Object.assign(process.env, planted);
  try {
    const snap = { ...process.env };
    const sb = sandboxEnv({ JEV_ENABLED: 'false', OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY, EXTRA_FLAG: 1, NC_GONE: null });
    try {
      assert.equal(process.env.JEV_ENABLED, 'false');
      assert.equal(process.env.LLM_MODEL_X, undefined, 'prefixo LLM_ limpo');
      assert.equal(process.env.DB_PATH, undefined, 'DB_PATH absoluto levaria ao banco REAL');
      assert.equal(process.env.OPENROUTER_API_KEY, FAKE_OPENROUTER_KEY);
      assert.equal(process.env.EXTRA_FLAG, '1');
      assert.equal(process.env.NC_GONE, undefined);
      assert.equal(process.env.NC_TEST, '1', 'sinal de teste p/ o tripwire do transporte padrão (W1)');
      assert.equal(process.env.NC_UNDER_TEST, '1', 'o que o restore.js já lê: filho da CLI não roda o bootstrap');
      assert.equal(process.env.NC_HOME, sb.home);
      assert.ok(sb.home.startsWith(realpathSync(os.tmpdir())), sb.home);
      assert.notEqual(sb.home, path.join(os.homedir(), '.newsletter-crawler'));
      const envTxt = readFileSync(sb.envFile, 'utf8');
      assert.match(envTxt, new RegExp(`^OPENROUTER_API_KEY=${FAKE_OPENROUTER_KEY}$`, 'm'));
      assert.match(envTxt, /^DEEPSEEK_API_KEY=$/m, 'chave neutralizada vence o .env do repo');
      assert.match(envTxt, /^DB_PATH=$/m);
      assert.match(envTxt, /^JEV_ENABLED=false$/m, 'override vai ao arquivo (o .env do repo carrega com override)');
    } finally {
      sb.restore();
    }
    assert.deepEqual({ ...process.env }, snap, 'restore devolve o env exato');
    assert.equal(existsSync(sb.home), false, 'tmpdir da sandbox removido');
    sb.restore(); // idempotente
    assert.deepEqual({ ...process.env }, snap);
  } finally {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('sandboxEnv: NC_HOME próprio é respeitado (nem semeado nem apagado); home:false não mexe no NC_HOME', () => {
  const own = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'nc-env-own-')));
  try {
    const sb = sandboxEnv({ NC_HOME: own });
    assert.equal(process.env.NC_HOME, own);
    assert.equal(sb.envFile, null);
    assert.equal(sb.createdHome, null);
    sb.restore();
    assert.ok(existsSync(own), 'diretório do teste não é apagado');

    const before = process.env.NC_HOME;
    const sb2 = sandboxEnv({}, { home: false, testFlag: false });
    assert.equal(process.env.NC_HOME, before);
    sb2.restore();
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
});

test('withSandboxEnv restaura mesmo quando a função lança', async () => {
  const snap = { ...process.env };
  let home = null;
  await assert.rejects(
    withSandboxEnv({ JEV_ENABLED: 'false' }, async (sb) => {
      home = sb.home;
      assert.equal(process.env.JEV_ENABLED, 'false');
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.deepEqual({ ...process.env }, snap);
  assert.equal(existsSync(home), false);
});

// ---- gemini-double ----

test('gemini-double: fila (payload→JSON, string crua, erro do SDK, repete a última), usage com custo e calls gravadas', async () => {
  const orig = OpenAI.Chat.Completions.prototype.create;
  const g = mockGemini([{ verdict: 'ok' }, 'not json', apiError(429, 'slow down', { 'retry-after': '0' }), { last: true }]);
  try {
    const client = new OpenAI({ apiKey: 'sk-or-test', baseURL: 'http://127.0.0.1:9/api/v1' });
    const body = {
      model: GEMINI_DOUBLE_MODEL,
      messages: [{ role: 'user', content: 'judge this' }],
      reasoning: { effort: 'low' },
      response_format: { type: 'json_schema', json_schema: { name: 'x', strict: true, schema: {} } },
      max_tokens: 1500,
    };
    const r1 = await client.chat.completions.create(body);
    assert.deepEqual(JSON.parse(r1.choices[0].message.content), { verdict: 'ok' });
    assert.equal(r1.model, GEMINI_DOUBLE_MODEL);
    assert.ok(r1.usage.prompt_tokens > 0 && r1.usage.completion_tokens > 0);
    assert.equal(
      r1.usage.cost,
      r1.usage.prompt_tokens * GEMINI_PRICE_IN_PER_TOKEN + r1.usage.completion_tokens * GEMINI_PRICE_OUT_PER_TOKEN,
    );

    assert.equal((await client.chat.completions.create(body)).choices[0].message.content, 'not json');
    await assert.rejects(
      client.chat.completions.create(body),
      (e) => e instanceof OpenAI.RateLimitError && e.status === 429 && e.headers.get('retry-after') === '0',
    );
    assert.deepEqual(JSON.parse((await client.chat.completions.create(body)).choices[0].message.content), { last: true });
    assert.deepEqual(
      JSON.parse((await client.chat.completions.create(body)).choices[0].message.content),
      { last: true },
      'fila esgotada: repete a última',
    );

    assert.equal(g.calls.length, 5);
    assert.equal(g.calls[0].body.reasoning.effort, 'low');
    assert.equal(g.calls[0].body.response_format.json_schema.strict, true);
    assert.equal(g.calls[0].body.max_tokens, 1500);
    assert.equal(g.calls[0].client.baseURL, 'http://127.0.0.1:9/api/v1');
    assert.equal(g.calls[2].error.status, 429);
    assert.equal(g.lastCall, g.calls[4]);
  } finally {
    g.restore();
  }
  assert.equal(OpenAI.Chat.Completions.prototype.create, orig, 'restore devolve o método original do SDK');
  g.restore(); // idempotente
});

test('gemini-double: handler recebe body/ctx, resposta completa passa intacta, signal abortado rejeita; 1 mock por vez', async () => {
  const seen = [];
  const full = { model: 'google/gemini-3.8-flash', choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0 } };
  const g = mockGemini((body, ctx) => {
    seen.push([body.model, ctx.index]);
    return ctx.index === 0 ? { first: true } : full;
  });
  try {
    assert.throws(() => mockGemini({}), /já existe um mockGemini ativo/);
    const client = new OpenAI({ apiKey: 'sk-or-test', baseURL: 'http://127.0.0.1:9/api/v1' });
    const b = { model: 'google/gemini-3.8-flash', messages: [] };
    assert.deepEqual(JSON.parse((await client.chat.completions.create(b)).choices[0].message.content), { first: true });
    assert.equal(await client.chat.completions.create(b), full);
    assert.deepEqual(seen, [['google/gemini-3.8-flash', 0], ['google/gemini-3.8-flash', 1]]);

    const ac = new AbortController();
    ac.abort();
    await assert.rejects(client.chat.completions.create(b, { signal: ac.signal }), OpenAI.APIUserAbortError);

    g.setHandler(['{"swapped":true}']);
    assert.equal((await client.chat.completions.create(b)).choices[0].message.content, '{"swapped":true}');
  } finally {
    g.restore();
  }
  const g2 = mockGemini(); // depois do restore, um novo mock é permitido
  g2.restore();
});
