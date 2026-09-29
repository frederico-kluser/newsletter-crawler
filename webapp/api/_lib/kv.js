// Cliente do Vercel KV (Upstash Redis) via REST puro (fetch) — zero dependências npm.
// Env esperadas (Marketplace Upstash no projeto): KV_REST_API_URL + KV_REST_API_TOKEN
// (aliases UPSTASH_REDIS_REST_URL/TOKEN também aceites). Sem KV: a LEITURA de config cai para
// env (ANALYSIS_* / WEBHOOK_URL) e as escritas/histórico devolvem 503 com mensagem acionável.
import { warn } from './log.js';

const CONFIG_KEY = 'nc:admin:config';
const RUNS_LIST_KEY = 'nc:admin:runs';
const runKey = (id) => `nc:admin:run:${id}`;
const RUNS_KEEP = 30;

export function kvConfig(env) {
  const url = env('KV_REST_API_URL') || env('UPSTASH_REDIS_REST_URL');
  const token = env('KV_REST_API_TOKEN') || env('UPSTASH_REDIS_REST_TOKEN');
  return url && token ? { url, token } : null;
}

export function kvAvailable(env) {
  return kvConfig(env) !== null;
}

/**
 * Executa comandos. Cada comando = array de args (["SET", k, v]).
 * Corpo Upstash: 1 comando → `["GET","k"]` (single) · N comandos → `[["GET","k"],…]` (pipeline).
 * Devolve um array com o `result` de cada comando (mesma ordem). A forma da RESPOSTA é decidida
 * pelo nº de comandos ENVIADOS (nunca pelo shape do valor — LRANGE devolve array num single).
 */
export async function kvExec(commands, env, transport) {
  const cfg = kvConfig(env);
  if (!cfg) {
    const err = new Error('sem Vercel KV/Upstash associado ao projeto — crie a base no dashboard e associe-a (ou use o modo env-only)');
    err.code = 'no-kv';
    throw err;
  }
  const cmds = commands.map((c) => (Array.isArray(c) ? c.map(String) : [String(c)]));
  const pipeline = cmds.length > 1;
  const body = JSON.stringify(pipeline ? cmds : cmds[0]);
  const res = await send(doFetch(transport), cfg, body);
  const parsed = typeof res.body === 'string' ? safeJson(res.body) : res.body;
  if (res.statusCode !== 200 || !parsed) {
    const err = new Error(`KV respondeu ${res.statusCode}: ${String(res.body).slice(0, 200)}`);
    err.code = 'kv-error';
    throw err;
  }
  const rows = pipeline ? (Array.isArray(parsed.result) ? parsed.result : []) : [parsed];
  return rows.map((row, i) => {
    if (row && row.error) {
      warn(`kv: erro no comando ${i}: ${row.error}`);
      const err = new Error(String(row.error));
      err.code = 'kv-error';
      throw err;
    }
    return row && Object.prototype.hasOwnProperty.call(row, 'result') ? row.result : null;
  });
}

function doFetch(transport) {
  return transport || null; // null = usar o fetch global em send()
}

async function send(transport, cfg, body) {
  const headers = { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' };
  if (!transport) {
    const res = await fetch(cfg.url, { method: 'POST', headers, body });
    return { statusCode: res.status, body: await res.text() };
  }
  return transport({ url: cfg.url, method: 'POST', headers, body, timeoutMs: 10000 });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function kvGetJson(key, env, transport) {
  const [raw] = await kvExec([['GET', key]], env, transport);
  return raw == null ? null : safeJson(String(raw));
}

export async function kvSetJson(key, value, env, transport) {
  await kvExec([['SET', key, JSON.stringify(value)]], env, transport);
}

// ---- configuração (input, período, fontes, limiar, webhook) ----

/** Config efetiva: KV (persistida pela página) > env (modo fixo sem KV) > null. */
export async function getAdminConfig(env, transport) {
  if (kvAvailable(env)) {
    try {
      const cfg = await kvGetJson(CONFIG_KEY, env, transport);
      if (cfg) return { ...cfg, source: 'kv' };
    } catch (err) {
      warn(`kv: falha ao ler config (${err.message}) — a cair para env`);
    }
  }
  return configFromEnv(env);
}

export function configFromEnv(env) {
  const input = env('ANALYSIS_INPUT');
  const webhookUrl = env('WEBHOOK_URL');
  if (!input && !webhookUrl) return null;
  return {
    input: input || '',
    from: env('ANALYSIS_FROM'),
    to: env('ANALYSIS_TO'),
    sourceIds: [],
    kind: 'all',
    threshold: Number.parseFloat(env('ANALYSIS_THRESHOLD')) || 0.5,
    webhookUrl: webhookUrl || '',
    updatedAt: null,
    source: 'env',
  };
}

/** Grava (merge) a config no KV. Sem KV → erro claro (a página mostra o como resolver). */
export async function saveAdminConfig(patch, env, transport) {
  const current = (await kvGetJson(CONFIG_KEY, env, transport)) || {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await kvSetJson(CONFIG_KEY, next, env, transport);
  return { ...next, source: 'kv' };
}

// ---- registos de run ----

function assertRunId(id) {
  const s = String(id || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) {
    const err = new Error('id de run inválido');
    err.code = 'bad-run-id';
    throw err;
  }
  return s;
}

export async function saveRunRecord(run, env, transport) {
  const id = assertRunId(run.id);
  await kvSetJson(runKey(id), run, env, transport);
  return run;
}

export async function createRunRecord(run, env, transport) {
  const id = assertRunId(run.id);
  await kvExec(
    [
      ['SET', runKey(id), JSON.stringify(run)],
      ['LPUSH', RUNS_LIST_KEY, id],
      ['LTRIM', RUNS_LIST_KEY, 0, RUNS_KEEP - 1],
    ],
    env,
    transport,
  );
  return run;
}

export async function getRunRecord(id, env, transport) {
  return kvGetJson(runKey(assertRunId(id)), env, transport);
}

/** Resumos das últimas runs (o registo completo fica por id — a página carrega o detalhe). */
export async function listRunSummaries(env, transport) {
  const [idsRaw] = await kvExec([['LRANGE', RUNS_LIST_KEY, 0, RUNS_KEEP - 1]], env, transport);
  const ids = (Array.isArray(idsRaw) ? idsRaw : []).map(String);
  if (!ids.length) return [];
  const rows = await kvExec(ids.map((id) => ['GET', runKey(id)]), env, transport);
  const out = [];
  for (const raw of rows) {
    const run = raw == null ? null : safeJson(String(raw));
    if (run) out.push(summarizeRun(run));
  }
  return out;
}

export function summarizeRun(run) {
  return {
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    scopeTotal: run.scope?.total ?? 0,
    processed: run.progress?.processed ?? 0,
    matched: run.matches?.length ?? 0,
    dispatchOk: run.dispatch?.ok ?? null,
    dispatchStatus: run.dispatch?.status ?? null,
    costUsd: run.usage?.cost ?? 0,
    error: run.error || null,
    injectionFlagged: run.injectionFlagged ?? 0,
  };
}
