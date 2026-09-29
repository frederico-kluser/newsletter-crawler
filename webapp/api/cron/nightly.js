// GET|POST /api/cron/nightly — a "busca completa" de toda a noite (vercel.json crons, 03:00 UTC;
// na Vercel Hobby o disparo acontece em QUALQUER momento dentro da hora). Protegido por
// Authorization: Bearer <CRON_SECRET> (o formato exato que a Vercel envia).
//
// Semântica auto-reparável: se existe uma run por concluir (de ontem, manual ou noturna), o cron
// TERMINA essa primeiro (é a busca completa em curso); só sem nenhuma pendente cria a de hoje.
// A run concluída dispara o JSON array ao webhook cadastrado (uma vez).
import { advanceRun, runView, startRun } from '../_lib/analyze.js';
import { requireCron } from '../_lib/auth.js';
import { adminSecrets, env, openrouterKey } from '../_lib/env.js';
import { allowMethod, bad, sendJson } from '../_lib/http.js';
import { getAdminConfig, kvAvailable, listRunSummaries } from '../_lib/kv.js';
import { log } from '../_lib/log.js';

const BUDGET_MS = 210000; // folga p/ responder dentro do teto de 300 s da função

export default async function handler(req, res) {
  const m = allowMethod(req, res, 'GET', 'POST');
  if (!m) return;
  const secrets = adminSecrets();
  const guard = requireCron(req, secrets);
  if (!guard.ok) return bad(res, guard.status, guard.code, guard.message);

  if (!kvAvailable(env)) return bad(res, 503, 'no-kv', 'as runs precisam do Vercel KV/Upstash associado ao projeto');
  if (!openrouterKey()) return bad(res, 503, 'no-openrouter-key', 'defina OPENROUTER_API_KEY nas Environment Variables do projeto');

  const config = await getAdminConfig(env);
  if (!config?.input) {
    log('cron: sem input configurado — nada a fazer');
    return sendJson(res, 200, { skipped: 'no-config', message: 'defina o input da análise na página /admin' });
  }

  // 1) terminar a run em curso (auto-reparo); 2) senão, a busca completa de hoje
  const pending = (await listRunSummaries(env)).find((r) => r.status === 'running');
  let run;
  if (pending) {
    log(`cron: retomando run pendente ${pending.id}`);
    run = await advanceRun(pending.id, { env, budgetMs: BUDGET_MS });
  } else {
    run = await startRun({ env, trigger: 'cron', config });
    run = await advanceRun(run.id, { env, budgetMs: BUDGET_MS });
  }
  return sendJson(res, 200, {
    run: runView(run),
    resumed: Boolean(pending),
    message: run.status === 'done' ? 'busca completa concluída' : 'run em curso — conclui no próximo passo/cron',
  });
}
