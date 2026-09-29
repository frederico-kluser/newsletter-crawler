// GET /api/admin/runs/:id — estado completo (com matches truncados) de uma run.
import { runView } from '../../_lib/analyze.js';
import { requireAdmin } from '../../_lib/auth.js';
import { adminSecrets, env } from '../../_lib/env.js';
import { allowMethod, bad, sendJson } from '../../_lib/http.js';
import { getRunRecord } from '../../_lib/kv.js';

export default async function handler(req, res) {
  const m = allowMethod(req, res, 'GET');
  if (!m) return;
  const secrets = adminSecrets();
  const guard = requireAdmin(req, secrets);
  if (!guard.ok) return bad(res, guard.status, guard.code, guard.message);
  const run = await getRunRecord(String(req.query?.id || ''), env);
  if (!run) return bad(res, 404, 'run-not-found', 'run não encontrada');
  return sendJson(res, 200, { run: runView(run) });
}
