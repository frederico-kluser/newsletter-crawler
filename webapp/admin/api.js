// Cliente da API do /admin (fetch JSON com erros normalizados). Same-origin + cookie de sessão.
async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* corpo não-JSON (proxy/HTML) — vira erro abaixo */
  }
  if (!res.ok) {
    const err = new Error(data?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data?.error || 'error';
    throw err;
  }
  return data;
}

export const api = {
  session: () => call('/api/admin/session'),
  login: (user, password) => call('/api/admin/login', { method: 'POST', body: { user, password } }),
  logout: () => call('/api/admin/logout', { method: 'POST' }),
  config: () => call('/api/admin/config'),
  saveConfig: (patch) => call('/api/admin/config', { method: 'PUT', body: patch }),
  scope: (patch) => call('/api/admin/scope', { method: 'POST', body: patch }),
  testWebhook: () => call('/api/admin/webhook-test', { method: 'POST' }),
  runs: () => call('/api/admin/runs'),
  startRun: () => call('/api/admin/runs', { method: 'POST' }),
  run: (id) => call(`/api/admin/runs/${id}`),
  stepRun: (id) => call(`/api/admin/runs/${id}/step`, { method: 'POST' }),
  redispatch: (id) => call(`/api/admin/runs/${id}/dispatch`, { method: 'POST' }),
};
