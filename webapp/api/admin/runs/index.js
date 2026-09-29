// GET  /api/admin/runs  — histórico (resumos) das runs.
// POST /api/admin/runs  — cria a run com a configuração SAVED e já avança o 1º passo (~25 s).
import { advanceRun, runView, startRun } from '../../_lib/analyze.js';
import { requireAdmin } from '../../_lib/auth.js';
import { adminSecrets, env, openrouterKey } from '../../_lib/env.js';
import { allowMethod, bad, sendJson } from '../../_lib/http.js';
import { getAdminConfig, kvAvailable, listRunSummaries } from '../../_lib/kv.js';

export default async function handler(req, res) {
  const m = allowMethod(req, res, 'GET', 'POST');
  if (!m) return;
  const secrets = adminSecrets();
  const guard = requireAdmin(req, secrets);
  if (!guard.ok) return bad(res, guard.status, guard.code, guard.message);
  if (!kvAvailable(env)) {
    return bad(res, 503, 'no-kv', 'as runs precisam do Vercel KV/Upstash associado ao projeto');
  }

  if (m === 'GET') {
    return sendJson(res, 200, { runs: await listRunSummaries(env) });
  }

  if (!openrouterKey()) {
    return bad(res, 503, 'no-openrouter-key', 'defina OPENROUTER_API_KEY nas Environment Variables do projeto');
  }
  const config = await getAdminConfig(env);
  if (!config?.input) return bad(res, 400, 'no-config', 'defina primeiro o input da análise');

  const run = await startRun({ env, trigger: 'manual', config });
  const advanced = await advanceRun(run.id, { env, budgetMs: 25000 });
  return sendJson(res, 200, { run: runView(advanced) });
}
