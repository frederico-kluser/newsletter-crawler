// POST /api/admin/runs/:id/step — avança a run (≈25 s de batches). A página repete até done.
import { advanceRun, runView } from '../../../_lib/analyze.js';
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
    const run = await advanceRun(String(req.query?.id || ''), { env, budgetMs: 25000 });
    return sendJson(res, 200, { run: runView(run) });
  } catch (err) {
    if (err?.code === 'run-not-found') return bad(res, 404, 'run-not-found', 'run não encontrada');
    throw err;
  }
}
