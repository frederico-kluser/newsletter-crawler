// Sessão do /admin: cookie assinado HMAC-SHA256 (sem store de sessão) + comparação de
// credenciais em tempo constante. Segredos entram por env (adminSecrets) e NUNCA saem em respostas.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'nc_admin';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

function hmac(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function eqConst(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // compara contra si mesmo para manter o tempo aproximadamente constante
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Emite uma sessão: `v1.<exp_ms>.<hmac>` (o exp entra na assinatura — não é editável). */
export function signSession(secret, now = Date.now(), ttlMs = SESSION_TTL_MS) {
  const exp = now + ttlMs;
  const payload = `v1.${exp}`;
  return { value: `${payload}.${hmac(secret, payload)}`, exp };
}

export function verifySession(value, secret, now = Date.now()) {
  if (typeof value !== 'string' || !secret) return false;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < now) return false;
  return eqConst(parts[2], hmac(secret, `v1.${parts[1]}`));
}

export function cookieHeader(value, maxAgeSec = SESSION_TTL_MS / 1000) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(maxAgeSec)}`;
}

export function clearCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function parseCookies(req) {
  const out = {};
  const raw = req.headers?.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** user/password contra env, comparados via hash SHA-256 em tempo constante. */
export function checkCredentials(user, password, secrets) {
  const dig = (s) => createHash('sha256').update(String(s ?? '')).digest();
  const a = dig(user);
  const b = dig(secrets.user);
  const c = dig(password);
  const d = dig(secrets.password);
  return timingSafeEqual(a, b) && timingSafeEqual(c, d);
}

/**
 * Guarda de TODOS os endpoints /api/admin/* (excepto login):
 * env em falta → 503 com instrução; cookie inválido/expirado → 401.
 */
export function requireAdmin(req, secrets) {
  if (!secrets.user || !secrets.password || !secrets.sessionSecret) {
    return {
      ok: false,
      status: 503,
      code: 'server-not-configured',
      message:
        'Defina ADMIN_USER, ADMIN_PASSWORD e ADMIN_SESSION_SECRET nas Environment Variables do projeto na Vercel (e faça redeploy).',
    };
  }
  const cookie = parseCookies(req)[SESSION_COOKIE];
  if (!verifySession(cookie, secrets.sessionSecret)) {
    return { ok: false, status: 401, code: 'unauthorized', message: 'sessão ausente ou expirada — faça login' };
  }
  return { ok: true };
}

/** Guarda do cron noturno: Authorization: Bearer <CRON_SECRET> (formato enviado pela Vercel). */
export function requireCron(req, secrets) {
  if (!secrets.cronSecret) {
    return {
      ok: false,
      status: 503,
      code: 'cron-not-configured',
      message: 'Defina CRON_SECRET nas Environment Variables do projeto na Vercel (e faça redeploy).',
    };
  }
  const auth = String(req.headers?.authorization || '');
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!eqConst(token, secrets.cronSecret)) {
    return { ok: false, status: 401, code: 'unauthorized', message: 'cron secret inválido' };
  }
  return { ok: true };
}
