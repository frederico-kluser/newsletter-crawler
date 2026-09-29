// POST /api/admin/runs/:id/dispatch — reenvia o JSON array de uma run concluída ao webhook.
import { redispatchRun, runView } from '../../../_lib/analyze.js';
import { requireAdmin } from '../../../_lib/auth.js';
import { adminSecrets, env } from '../../../_lib/env.js';
import { allowMethod, bad, sendJson } from '../../../_lib/http.js';

export default async function handler(req, res) {
  const m = allowMethod(req, res, 'POST');
  if (!m) return;
  const secrets = adminSecrets();
  const guard = requireAdmin(req, secrets);
  if (!guard.ok) return bad(res, guard.status, guard.code, guard.message);
  try {
    const run = await redispatchRun(String(req.query?.id || ''), { env });
    return sendJson(res, 200, { run: runView(run) });
  } catch (err) {
    if (err?.code === 'run-not-found') return bad(res, 404, 'run-not-found', 'run não encontrada');
    throw err;
  }
}
