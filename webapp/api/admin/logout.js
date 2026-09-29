// POST /api/admin/logout — limpa o cookie de sessão.
import { clearCookieHeader } from '../_lib/auth.js';
import { allowMethod, sendJson } from '../_lib/http.js';

export default async function handler(req, res) {
  const m = allowMethod(req, res, 'POST');
  if (!m) return;
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookieHeader() });
}
