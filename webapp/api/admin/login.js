// POST /api/admin/login — único endpoint público dos /api/admin/*: valida user/password (tempo
// constante) e emite o cookie de sessão assinado. Sem segredos configurados → 503 com instrução.
import { checkCredentials, clearCookieHeader, cookieHeader, SESSION_TTL_MS, signSession } from '../_lib/auth.js';
import { adminSecrets } from '../_lib/env.js';
import { allowMethod, bad, readJsonBody, sendJson, sleep } from '../_lib/http.js';
import { log, warn } from '../_lib/log.js';

export default async function handler(req, res) {
  const m = allowMethod(req, res, 'POST');
  if (!m) return;
  const secrets = adminSecrets();
  if (!secrets.user || !secrets.password || !secrets.sessionSecret) {
    return bad(
      res,
      503,
      'server-not-configured',
      'Defina ADMIN_USER, ADMIN_PASSWORD e ADMIN_SESSION_SECRET nas Environment Variables do projeto na Vercel (e faça redeploy).',
    );
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return bad(res, 400, 'bad-json', 'corpo JSON inválido');
  }
  if (!checkCredentials(body?.user, body?.password, secrets)) {
    warn('login inválido');
    await sleep(400 + Math.floor(Math.random() * 400)); // amortece força-bruta
    sendJson(res, 401, { error: 'invalid-credentials', message: 'usuário ou senha inválidos' }, { 'Set-Cookie': clearCookieHeader() });
    return;
  }
  const { value, exp } = signSession(secrets.sessionSecret);
  log('login ok');
  sendJson(res, 200, { ok: true, expiresAt: new Date(exp).toISOString() }, { 'Set-Cookie': cookieHeader(value, SESSION_TTL_MS / 1000) });
}
