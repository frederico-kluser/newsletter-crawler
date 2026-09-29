// Leitura de ENV do backend (Vercel). Tudo por parâmetro/retorno — nenhum módulo aqui lê env
// no import. Fontes de configuração do deploy: docs/admin-backend.md.
import { JEV_MODEL_DEFAULT } from '../../src/shared/jev-core.js';

export function env(name) {
  return String(process.env[name] ?? '').trim();
}

export function envInt(name, def) {
  const n = Number.parseInt(env(name), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export function envFloat(name, def) {
  const n = Number.parseFloat(env(name));
  return Number.isFinite(n) ? n : def;
}

/** Chave OpenRouter do BACKEND (a do navegador/BYOK não serve aqui). */
export function openrouterKey() {
  return env('OPENROUTER_API_KEY') || env('NC_OPENROUTER_API_KEY');
}

/** Segredos do admin: login, sessão, assinatura do webhook e do cron. NUNCA saem em respostas. */
export function adminSecrets() {
  return {
    user: env('ADMIN_USER'),
    password: env('ADMIN_PASSWORD'),
    sessionSecret: env('ADMIN_SESSION_SECRET'),
    webhookSecret: env('WEBHOOK_SECRET'),
    cronSecret: env('CRON_SECRET'),
  };
}

/**
 * Base URL de onde o snapshot publicado é lido (`/data/meta.json` + `/data/articles.json`).
 * Default: a própria produção do projeto na Vercel; override com NC_DATA_BASE_URL (testes/preview).
 */
export function dataBaseUrl() {
  const custom = env('NC_DATA_BASE_URL');
  if (custom) return custom.replace(/\/$/, '');
  for (const name of ['VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL']) {
    const host = env(name);
    if (!host) continue;
    return (/^https?:\/\//.test(host) ? host : `https://${host}`).replace(/\/$/, '');
  }
  return 'http://localhost:8477';
}

/** Configuração do Jev (Decisions API). Slugs/limites vêm do jev-core (fonte única). */
export function jevSettings() {
  return {
    model: env('NC_JEV_MODEL') || JEV_MODEL_DEFAULT,
    baseUrl: env('NC_JEV_BASE_URL') || 'https://openrouter.ai/api/alpha/decisions',
    batchSize: envInt('NC_JEV_BATCH', 30),
    concurrency: envInt('NC_JEV_CONCURRENCY', 6),
    timeoutMs: envInt('NC_JEV_TIMEOUT_MS', 30000),
    maxAttempts: envInt('NC_JEV_ATTEMPTS', 4),
  };
}

/** Modelo por omissão do limiar de separação ("separadas" = p ≥ limiar). */
export const DEFAULT_THRESHOLD = 0.5;
