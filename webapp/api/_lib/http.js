// HTTP helpers das funções Vercel (ServerResponse vanilla — testável sem framework).
import { warn } from './log.js';

export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body ?? null);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(payload);
}

export function bad(res, status, code, message) {
  sendJson(res, status, { error: code, message });
}

/** Devolve o método normalizado ou já responde 405. */
export function allowMethod(req, res, ...allowed) {
  const m = String(req.method || 'GET').toUpperCase();
  if (allowed.includes(m)) return m;
  res.setHeader('Allow', allowed.join(', '));
  bad(res, 405, 'method-not-allowed', `use ${allowed.join(' | ')}`);
  return null;
}

/**
 * Corpo JSON do pedido. O runtime da Vercel já faz parse em `req.body` (objeto|string|Buffer);
 * o fallback lê a stream para o runtime vanilla/testes. Lança em JSON inválido.
 */
export async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== '') {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    return raw ? JSON.parse(raw) : {};
  }
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/**
 * Transporte HTTP genérico (fetch) com timeout — mesmo shape do dublê do Jev
 * (test/helpers/jev-double.js): {url, method, headers, body, timeoutMs} → {statusCode, body, headers}.
 * Injetável nos módulos que chamam a rede (jev.js/dispatch.js) para testes offline.
 */
export async function httpTransport({ url, method = 'POST', headers = {}, body, timeoutMs = 30000 }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctl.signal });
    const text = await res.text();
    return { statusCode: res.status, body: text, headers: Object.fromEntries(res.headers.entries()) };
  } catch (err) {
    warn(`transporte: ${method} ${url} → ${err.name || 'erro'}: ${err.message}`);
    return { statusCode: 0, body: String(err.message || err), headers: {} };
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
