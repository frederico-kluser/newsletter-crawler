// Disparo do JSON array ao webhook cadastrado no /admin.
// Contrato (docs/admin-backend.md): body = ARRAY PURO de notícias separadas; headers carregam o
// contexto da run (id/trigger/data) e a assinatura HMAC (X-NC-Signature) quando WEBHOOK_SECRET existe.
import { createHmac } from 'node:crypto';
import { httpTransport, sleep } from './http.js';
import { warn } from './log.js';

const PRIVATE_V4 = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0$)/;
const PRIVATE_V6 = /^(fc|fd|fe80:|::1$|\[::1\]$)/i;

/** Guarda anti-SSRF básica: só http(s) e nunca localhost/link-local/redes privadas. */
export function validateWebhookUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: true, url: '' };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, message: 'URL inválida' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, message: 'use http:// ou https://' };
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal' ||
    PRIVATE_V4.test(host) ||
    PRIVATE_V6.test(host)
  ) {
    return { ok: false, message: 'host interno/privado bloqueado — use uma URL pública' };
  }
  return { ok: true, url: u.toString() };
}

export function signPayload(body, secret) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * POST do array ao webhook. 2xx = ok; 4xx = falha terminal (não tenta de novo); 5xx/429/rede =
 * retry (3 tentativas, backoff 2s/5s). Devolve {ok, status, attempts, error}.
 */
export async function dispatchWebhook({
  url,
  items,
  secret,
  runId,
  trigger,
  isTest = false,
  transport = httpTransport,
  timeoutMs = 15000,
  attempts = 3,
}) {
  const check = validateWebhookUrl(url);
  if (!check.ok) return { ok: false, status: 0, attempts: 0, error: check.message };
  if (!check.url) return { ok: false, status: 0, attempts: 0, error: 'sem webhook cadastrado' };

  const body = JSON.stringify(Array.isArray(items) ? items : []);
  const headers = {
    'content-type': 'application/json',
    'x-nc-run-id': String(runId || ''),
    'x-nc-trigger': String(trigger || ''),
    'x-nc-generated-at': new Date().toISOString(),
    'x-nc-count': String((items || []).length),
  };
  if (isTest) headers['x-nc-test'] = '1';
  if (secret) headers['x-nc-signature'] = signPayload(body, secret);

  let last = { ok: false, status: 0, attempts: 0, error: 'sem tentativa' };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await transport({ url: check.url, method: 'POST', headers, body, timeoutMs });
    last = { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, attempts: attempt, error: null };
    if (last.ok) return last;
    last.error = String(res.body || `HTTP ${res.statusCode}`).slice(0, 300);
    const retryable = res.statusCode === 0 || res.statusCode === 429 || res.statusCode >= 500;
    if (!retryable || attempt >= attempts) break;
    const waitMs = attempt === 1 ? 2000 : 5000;
    warn(`webhook HTTP ${res.statusCode} (tentativa ${attempt}/${attempts}) — retry em ${waitMs}ms`);
    await sleep(waitMs);
  }
  return last;
}
