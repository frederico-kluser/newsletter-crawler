// POST /api/admin/webhook-test — dispara um ping no webhook cadastrado: array vazio `[]` com
// X-NC-Test: 1 (o receptor distingue de uma entrega real pelo header).
import { requireAdmin } from '../_lib/auth.js';
import { adminSecrets, env } from '../_lib/env.js';
import { dispatchWebhook } from '../_lib/dispatch.js';
import { allowMethod, bad, sendJson } from '../_lib/http.js';
import { getAdminConfig } from '../_lib/kv.js';

export default async function handler(req, res) {
  const m = allowMethod(req, res, 'POST');
  if (!m) return;
  const secrets = adminSecrets();
  const guard = requireAdmin(req, secrets);
  if (!guard.ok) return bad(res, guard.status, guard.code, guard.message);
  const config = await getAdminConfig(env);
  if (!config?.webhookUrl) return bad(res, 400, 'no-webhook', 'cadastre primeiro a URL do webhook');
  const result = await dispatchWebhook({
    url: config.webhookUrl,
    items: [],
    secret: secrets.webhookSecret,
    runId: 'test',
    trigger: 'test',
    isTest: true,
  });
  return sendJson(res, result.ok ? 200 : 502, { result });
}
