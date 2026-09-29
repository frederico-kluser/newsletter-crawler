// GET|PUT /api/admin/config — a configuração da análise (input, período do site, fontes, limiar)
// e o webhook de disparo. Grava no KV (modo persistente); sem KV a leitura cai para env (fixa).
import { requireAdmin } from '../_lib/auth.js';
import { DEFAULT_THRESHOLD, adminSecrets, env } from '../_lib/env.js';
import { allowMethod, bad, readJsonBody, sendJson } from '../_lib/http.js';
import { validateWebhookUrl } from '../_lib/dispatch.js';
import { getAdminConfig, kvAvailable, saveAdminConfig } from '../_lib/kv.js';

const KINDS = new Set(['all', 'news', 'tool', 'release']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Sanitiza o patch do PUT. Devolve {ok, patch} ou {ok:false, message}. */
export function sanitizeConfigPatch(body) {
  const patch = {};
  const b = body && typeof body === 'object' ? body : {};
  if ('input' in b) {
    const input = String(b.input ?? '').trim();
    if (input.length > 2000) return { ok: false, message: 'o input tem no máximo 2000 caracteres' };
    patch.input = input;
  }
  for (const key of ['from', 'to']) {
    if (!(key in b)) continue;
    const v = String(b[key] ?? '').trim();
    if (v && !DATE_RE.test(v)) return { ok: false, message: `${key} deve ser AAAA-MM-DD` };
    patch[key] = v;
  }
  if (patch.from && patch.to && patch.from > patch.to) return { ok: false, message: 'o início do período é depois do fim' };
  if ('sourceIds' in b) {
    const ids = Array.isArray(b.sourceIds) ? b.sourceIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    if (ids.length > 500) return { ok: false, message: 'muitas fontes selecionadas' };
    patch.sourceIds = [...new Set(ids)];
  }
  if ('kind' in b) {
    const kind = String(b.kind ?? 'all');
    if (!KINDS.has(kind)) return { ok: false, message: 'kind deve ser all|news|tool|release' };
    patch.kind = kind;
  }
  if ('threshold' in b) {
    const th = Number(b.threshold);
    if (!Number.isFinite(th) || th < 0.05 || th > 0.95) return { ok: false, message: 'o limiar deve ficar entre 0.05 e 0.95' };
    patch.threshold = th;
  }
  if ('webhookUrl' in b) {
    const check = validateWebhookUrl(b.webhookUrl);
    if (!check.ok) return { ok: false, message: `webhook: ${check.message}` };
    patch.webhookUrl = check.url;
  }
  return { ok: true, patch };
}

export default async function handler(req, res) {
  const m = allowMethod(req, res, 'GET', 'PUT');
  if (!m) return;
  const secrets = adminSecrets();
  const guard = requireAdmin(req, secrets);
  if (!guard.ok) return bad(res, guard.status, guard.code, guard.message);

  if (m === 'GET') {
    const config = await getAdminConfig(env);
    return sendJson(res, 200, {
      config: config || { input: '', from: '', to: '', sourceIds: [], kind: 'all', threshold: DEFAULT_THRESHOLD, webhookUrl: '', source: null },
    });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return bad(res, 400, 'bad-json', 'corpo JSON inválido');
  }
  const { ok, patch, message } = sanitizeConfigPatch(body);
  if (!ok) return bad(res, 400, 'invalid-config', message);
  if (!kvAvailable(env)) {
    return bad(
      res,
      503,
      'no-kv',
      'Sem Vercel KV/Upstash associado ao projeto não há como guardar a configuração — crie a base no dashboard da Vercel e associe-a ao projeto (ou configure ANALYSIS_INPUT/WEBHOOK_URL por env).',
    );
  }
  const config = await saveAdminConfig(patch, env);
  return sendJson(res, 200, { config });
}
