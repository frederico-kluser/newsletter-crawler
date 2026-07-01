// Gerência da chave do OpenRouter no local previsível (NC_HOME/.env): validação via probe
// (GET /api/v1/key -> 200) e upsert idempotente no arquivo .env. Sem efeito colateral ao importar.
// HTTP pelo `got` (regra do repo: nunca `axios`). Não faz log — quem chama (commands.js) loga.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import got from 'got';
import { ENV_PATH } from './config.js';

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
    const res = await got('https://openrouter.ai/api/v1/key', {
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
