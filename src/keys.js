// Gerência da chave LLM no local previsível (NC_HOME/.env): validação via probe por PROVEDOR
// (OpenRouter GET /api/v1/key, DeepSeek GET /models — 200 = válida) e upsert idempotente no
// arquivo .env. Sem efeito colateral ao importar. HTTP pelo `got` (regra do repo: nunca `axios`).
// Não faz log — quem chama (commands.js/web.js) loga.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import got from 'got';
// OPENROUTER_API_KEY é LIVE BINDING (export let do config): lido só em call-time (default de
// parâmetro do getKeyUsage), então vê a chave trocada em runtime pelo setRuntimeKey.
import { LLM_PROVIDER, ENV_PATH, OPENROUTER_API_KEY } from './config.js';

// ---- descritores por provedor (espelha providerInfo() de config.js, mas por NOME) ----
// O cmdKey com --provider e o dispatcher precisam do keyVar/baseURL de um provedor que pode NÃO
// ser o ativo (ex.: `key set --provider deepseek` com openrouter ativo). O baseURL da DeepSeek é
// lido do ENV em CALL-TIME (como em config.js) para os testes apontarem p/ um servidor local.
export function providerInfoFor(provider) {
  const isDs = String(provider || '').toLowerCase() === 'deepseek';
  return isDs
    ? { name: 'DeepSeek', keyVar: 'DEEPSEEK_API_KEY', baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com' }
    : { name: 'OpenRouter', keyVar: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1' };
}

/** Mascara a chave para log/eco (mantém prefixo + sufixo). `sk-or-v1-abcd…wxyz`. */
export function maskKey(k) {
  const s = String(k || '');
  if (!s) return '(vazia)';
  if (s.length <= 12) return `${s.slice(0, 2)}…`;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

/**
 * Valida uma chave OpenRouter contra GET /api/v1/key (200 = válida). Defensivo: erro de
 * rede/timeout NÃO lança — retorna { ok:false, status:0, reason }. Nunca derruba o processo.
 */
export async function probeOpenRouterKey(key) {
  if (!key) return { ok: false, status: 0, reason: 'chave vazia' };
  try {
    const res = await got(`${providerInfoFor('openrouter').baseURL}/key`, {
      headers: { Authorization: `Bearer ${key}` },
      throwHttpErrors: false, // 401/403 devolvem statusCode em vez de lançar
      timeout: { request: 15000 },
      retry: { limit: 1 },
    });
    return { ok: res.statusCode === 200, status: res.statusCode };
  } catch (e) {
    return { ok: false, status: 0, reason: e.message };
  }
}

// ---- consumo da chave OpenRouter (GET /api/v1/key — grátis: não gasta crédito) ----
// Origem da API lida em CALL-TIME: o ORIGIN de OPENROUTER_BASE_URL quando setado (o teste aponta
// p/ um servidor local e nunca toca a rede paga); sem env, o host público. URL inválida = default.
function openrouterOrigin() {
  const raw = process.env.OPENROUTER_BASE_URL;
  if (raw) {
    try {
      return new URL(raw).origin;
    } catch {
      /* OPENROUTER_BASE_URL malformada: cai no host público (fail-open) */
    }
  }
  return 'https://openrouter.ai';
}

// O `label` que a API devolve costuma ser a PRÓPRIA chave truncada (sk-or-v1-abc...xyz): tudo que
// tem cara de chave sai mascarado. Um nome dado pelo usuário no painel passa como está (não é segredo).
function redactKeyLabel(label) {
  if (label == null || label === '') return null;
  const s = String(label);
  return /sk-/i.test(s) ? maskKey(s) : s;
}

// Valor em USD da resposta: número finito ou null (null = "não informado", NUNCA zero — `limit`
// null na OpenRouter significa chave SEM teto de crédito).
function usdOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Consumo da chave OpenRouter: GET {origin}/api/v1/key → data.usage / limit / limit_remaining
 * (USD, acumulado da vida da chave). Base do guard de gasto do desenvolvimento
 * (scripts/dev-spend.mjs). Mesmo contrato defensivo dos probes: NUNCA lança — falha devolve
 * { ok:false, status, reason } com os números em null; quem decide gasto trata null como
 * DESCONHECIDO (fail-safe), nunca como zero. O label sai mascarado; a chave nunca é devolvida.
 */
export async function getKeyUsage(key = OPENROUTER_API_KEY, { timeoutMs = 15000 } = {}) {
  const empty = { usage: null, limit: null, limit_remaining: null, label: null };
  if (!key) return { ok: false, status: 0, reason: 'chave vazia', ...empty };
  try {
    const res = await got(`${openrouterOrigin()}/api/v1/key`, {
      headers: { Authorization: `Bearer ${key}` },
      throwHttpErrors: false, // 401/403 devolvem statusCode em vez de lançar
      timeout: { request: timeoutMs },
      retry: { limit: 1 },
    });
    if (res.statusCode !== 200) {
      return { ok: false, status: res.statusCode, reason: `HTTP ${res.statusCode}`, ...empty };
    }
    let data = null;
    try {
      data = JSON.parse(res.body)?.data ?? null;
    } catch {
      data = null; // corpo não-JSON (proxy/página de erro): cai no "sem data.usage" abaixo
    }
    const usage = usdOrNull(data?.usage);
    if (!data || usage == null) {
      return { ok: false, status: res.statusCode, reason: 'resposta sem data.usage', ...empty };
    }
    return {
      ok: true,
      status: res.statusCode,
      usage,
      limit: usdOrNull(data.limit),
      limit_remaining: usdOrNull(data.limit_remaining),
      label: redactKeyLabel(data.label),
    };
  } catch (e) {
    return { ok: false, status: 0, reason: e.message, ...empty };
  }
}

/**
 * Valida uma chave DeepSeek contra GET {DEEPSEEK_BASE_URL}/models (200 = válida; 401 = chave
 * errada — verificado por probe real). Mesmo contrato defensivo do probe da OpenRouter.
 */
export async function probeDeepSeekKey(key) {
  if (!key) return { ok: false, status: 0, reason: 'chave vazia' };
  try {
    const res = await got(`${providerInfoFor('deepseek').baseURL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      throwHttpErrors: false,
      timeout: { request: 15000 },
      retry: { limit: 1 },
    });
    return { ok: res.statusCode === 200, status: res.statusCode };
  } catch (e) {
    return { ok: false, status: 0, reason: e.message };
  }
}

/**
 * Dispatcher do probe por provedor: `probeProviderKey(key, provider = LLM_PROVIDER)` roteia
 * p/ a API do provedor certo. Os chamadores (cmdKey, POST /api/key) usam SÓ isto — não sabem
 * qual probe roda. Provider inválido/ausente = openrouter (mesma regra do config).
 */
export function probeProviderKey(key, provider = LLM_PROVIDER) {
  return providerInfoFor(provider).name === 'DeepSeek'
    ? probeDeepSeekKey(key)
    : probeOpenRouterKey(key);
}

/**
 * Upsert idempotente de `NAME=value` num arquivo .env, preservando as demais linhas. Injetável
 * (`file`) p/ teste. Cria o diretório/arquivo se preciso. Retorna { updated, file }.
 */
export function upsertEnvVar(name, value, file = ENV_PATH) {
  let lines = [];
  let existed = false;
  if (existsSync(file)) {
    try {
      lines = readFileSync(file, 'utf8').split(/\r?\n/);
      existed = true;
    } catch {
      lines = [];
    }
  }
  const re = new RegExp(`^\\s*${name}\\s*=`);
  const idx = lines.findIndex((l) => re.test(l));
  const entry = `${name}=${value}`;
  if (idx >= 0) {
    lines[idx] = entry;
  } else {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop(); // sem linhas vazias no fim
    lines.push(entry);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.join('\n').replace(/\n*$/, '') + '\n');
  return { updated: existed && idx >= 0, file };
}
