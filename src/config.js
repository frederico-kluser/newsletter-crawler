// Configuração central: carrega .env, sources e constantes.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Carrega o .env do projeto e faz OVERRIDE de variáveis herdadas do shell.
// (Tanto `node --env-file` quanto process.loadEnvFile NÃO sobrescrevem variáveis
//  que já existem no ambiente; aqui o .env do projeto tem precedência, para honrar
//  a chave que o usuário salvou — evitando que uma OPENROUTER_API_KEY antiga no
//  perfil do shell "sombreie" a correta.)
function loadDotEnvOverride(file) {
  if (!existsSync(file)) return;
  let txt = '';
  try {
    txt = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) process.env[key] = val;
  }
}
loadDotEnvOverride(path.join(ROOT, '.env'));

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
export const HAS_LLM = Boolean(OPENROUTER_API_KEY);

export const MODELS = {
  pro: process.env.LLM_PRO_MODEL || 'deepseek/deepseek-v4-pro',
  flash: process.env.LLM_FLASH_MODEL || 'deepseek/deepseek-v4-flash',
};

export const USER_AGENT =
  process.env.CRAWLER_UA ||
  'NewsletterArchiver/1.0 (+https://example.com/bot; contato: you@example.com)';

export const HTTP_REFERER = process.env.OPENROUTER_REFERER || 'https://example.com';
export const X_TITLE = 'NewsletterArchiver';

export const DB_PATH = process.env.DB_PATH
  ? path.resolve(ROOT, process.env.DB_PATH)
  : path.join(ROOT, 'data', 'crawler.db');

export const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
export const PER_HOST_CONCURRENCY = Number(process.env.PER_HOST_CONCURRENCY || 2);
export const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 1000);
export const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
export const MAX_HTML_FOR_LLM = Number(process.env.MAX_HTML_FOR_LLM || 120000);
export const RESPECT_ROBOTS = process.env.CRAWLER_RESPECT_ROBOTS !== 'false';

export function loadSources() {
  const p = path.join(ROOT, 'config', 'sources.json');
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(raw.sources) ? raw.sources : [];
  } catch {
    return [];
  }
}
