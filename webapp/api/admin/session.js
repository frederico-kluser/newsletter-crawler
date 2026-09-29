// GET /api/admin/session — estado para a página decidir entre login / não-configurado / área admin.
// Nunca devolve segredos: só presenças (keyPresent/kvPresent) e o modelo Jev ativo.
import { requireAdmin } from '../_lib/auth.js';
import { adminSecrets, dataBaseUrl, env, jevSettings, openrouterKey } from '../_lib/env.js';
import { allowMethod, bad, sendJson } from '../_lib/http.js';
import { getAdminConfig, kvAvailable } from '../_lib/kv.js';

export default async function handler(req, res) {
  const m = allowMethod(req, res, 'GET');
  if (!m) return;
  const secrets = adminSecrets();
  const guard = requireAdmin(req, secrets);
  if (!guard.ok) return bad(res, guard.status, guard.code, guard.message);
  const config = await getAdminConfig(env);
  sendJson(res, 200, {
    ok: true,
    keyPresent: Boolean(openrouterKey()),
    kvPresent: kvAvailable(env),
    hasConfig: Boolean(config?.input),
    hasWebhook: Boolean(config?.webhookUrl),
    configSource: config?.source || null,
    jev: { model: jevSettings().model },
    dataBase: dataBaseUrl(),
    now: new Date().toISOString(),
  });
}
