// Smoke drive da página /admin com a API SIMULADA (page.route) — zero LLM, zero KV.
// Verifica o fluxo inteiro da UI: login → config (input + período + fontes + limiar) → guardar →
// testar webhook → executar (step loop) → resultados + histórico. Screenshots em scripts/out/.
// Rode: `npm run build && node scripts/admin-smoke.mjs` em webapp/ (usa o playwright da raiz).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const webappDir = path.resolve(here, '..');
const outDir = path.join(here, 'out');
mkdirSync(outDir, { recursive: true });

const PORT = 4319;
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: webappDir,
  stdio: 'ignore',
});
const kill = () => {
  try {
    server.kill('SIGTERM');
  } catch {
    /* já morreu */
  }
};
process.on('exit', kill);

let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try {
    up = (await fetch(BASE)).ok;
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}
if (!up) {
  console.error('vite preview não subiu em', BASE);
  kill();
  process.exit(1);
}

// ---- estado da API simulada ----
let loggedIn = false;
let savedConfig = { input: '', from: '', to: '', sourceIds: [], kind: 'all', threshold: 0.5, webhookUrl: '' };
const mkRun = (over = {}) => ({
  id: 'run-smoke-1',
  trigger: 'manual',
  status: 'running',
  startedAt: '2026-09-28T03:00:00.000Z',
  finishedAt: null,
  config: { input: 'agentes de IA', from: '2026-01-01', to: '', sourceIds: [], kind: 'all', threshold: 0.5, webhookUrl: 'https://hooks.exemplo.com/x' },
  scope: { total: 1284, batches: 43, batchSize: 30 },
  progress: { done: 10, total: 43, processed: 300 },
  stats: { yes: 2, no: 295, uncertain: 3, noAnswer: 0 },
  injectionFlagged: 0,
  matches: [
    { id: 3, url: 'https://exemplo.com/mcp', title: 'MCP servers in practice', title_pt: 'MCP na prática', date_iso: '2026-09-03', kind: 'news', source: { id: 2, name: 'Beta' }, summary_pt: 'Resumo três.', tags: {}, verify_status: 'ok', jev: { p: 0.92, decision: 'yes', model: 'typesafe/jev-1.13-20260917', injection_flag: false } },
    { id: 1, url: 'https://exemplo.com/ai', title: 'AI agents take over CI', title_pt: 'Agentes de IA na CI', date_iso: '2026-09-01', kind: 'news', source: { id: 1, name: 'Alpha' }, summary_pt: 'Resumo um.', tags: {}, verify_status: 'ok', jev: { p: 0.88, decision: 'yes', model: 'typesafe/jev-1.13-20260917', injection_flag: false } },
  ],
  matchesTotal: 2,
  usage: { requests: 2, inputTokens: 2400, outputTokens: 0, cost: 0.0001 },
  model: 'typesafe/jev-1.13-20260917',
  dispatch: { ok: true, status: 200, attempts: 1, error: null, dispatchedAt: '2026-09-28T03:01:00.000Z' },
  lastError: null,
  error: null,
  ...over,
});

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'pt-BR' });
const page = await ctx.newPage();
const fails = [];
const check = (name, cond) => {
  console.log(`${cond ? '✔' : '✖'} ${name}`);
  if (!cond) fails.push(name);
};

await page.route('**/api/admin/**', async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const p = url.pathname;
  const method = req.method();
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (p === '/api/admin/session') {
    return loggedIn
      ? json(200, { ok: true, keyPresent: true, kvPresent: true, hasConfig: Boolean(savedConfig.input), hasWebhook: Boolean(savedConfig.webhookUrl), configSource: 'kv', jev: { model: 'typesafe/jev-1.13' }, dataBase: BASE, now: '2026-09-28T02:59:00.000Z' })
      : json(401, { error: 'unauthorized', message: 'sessão ausente ou expirada — faça login' });
  }
  if (p === '/api/admin/login' && method === 'POST') {
    const body = req.postDataJSON();
    if (body?.user === 'admin' && body?.password === 'segredo') {
      loggedIn = true;
      return json(200, { ok: true, expiresAt: '2026-10-05T03:00:00.000Z' });
    }
    return json(401, { error: 'invalid-credentials', message: 'usuário ou senha inválidos' });
  }
  if (p === '/api/admin/logout') {
    loggedIn = false;
    return json(200, { ok: true });
  }
  if (p === '/api/admin/config') {
    if (method === 'PUT') savedConfig = { ...savedConfig, ...req.postDataJSON() };
    return json(200, { config: { ...savedConfig, source: 'kv', updatedAt: '2026-09-28T03:00:00.000Z' } });
  }
  if (p === '/api/admin/scope') return json(200, { total: 1284, batches: 43, estUsd: 0.0086 });
  if (p === '/api/admin/webhook-test') return json(200, { result: { ok: true, status: 200, attempts: 1, error: null } });
  if (p === '/api/admin/runs' && method === 'GET') {
    return json(200, {
      runs: [{ id: 'run-smoke-0', trigger: 'cron', status: 'done', startedAt: '2026-09-27T03:00:00.000Z', finishedAt: '2026-09-27T03:02:00.000Z', scopeTotal: 1200, processed: 1200, matched: 5, dispatchOk: true, dispatchStatus: 200, costUsd: 0.0004, error: null, injectionFlagged: 0 }],
    });
  }
  if (p === '/api/admin/runs' && method === 'POST') return json(200, { run: mkRun() });
  if (/^\/api\/admin\/runs\/[^/]+\/step$/.test(p)) return json(200, { run: mkRun({ status: 'done', progress: { done: 43, total: 43, processed: 1284 }, finishedAt: '2026-09-28T03:02:00.000Z' }) });
  if (/^\/api\/admin\/runs\/[^/]+\/dispatch$/.test(p)) return json(200, { run: mkRun({ status: 'done' }) });
  if (/^\/api\/admin\/runs\/[^/]+$/.test(p)) return json(200, { run: mkRun({ status: 'done', progress: { done: 43, total: 43, processed: 1284 } }) });
  return json(404, { error: 'not-found', message: p });
});

try {
  // 1) login
  await page.goto(`${BASE}/admin/`);
  await page.waitForSelector('h2:has-text("Entrar")');
  check('tela de login aparece', true);
  await page.screenshot({ path: path.join(outDir, 'admin-01-login.png') });

  await page.fill('#adm-user', 'admin');
  await page.fill('#adm-pass', 'senha-errada');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.adm-notice-error');
  check('credencial errada mostra erro', (await page.locator('.adm-notice-error').innerText()).includes('usuário ou senha inválidos'));

  await page.fill('#adm-pass', 'segredo');
  await page.click('button[type="submit"]');
  await page.waitForSelector('h2:has-text("Análise JEV")');
  check('login ok → área admin', true);

  // 2) configuração
  await page.fill('#adm-input', 'agentes de IA e MCP');
  await page.fill('input[type="date"][class*="date-field"]', '2026-01-01').catch(() => {});
  await page.waitForFunction(() => document.body.innerText.includes('artigos no escopo'), null, { timeout: 5000 });
  check('estimativa de escopo/custo aparece', (await page.locator('body').innerText()).includes('1.284 artigos no escopo'));
  await page.screenshot({ path: path.join(outDir, 'admin-02-config.png') });

  await page.click('button:has-text("Guardar")');
  await page.waitForSelector('.adm-notice-ok');
  check('guardar config confirma', true);

  // 3) webhook
  await page.fill('#adm-webhook', 'https://hooks.exemplo.com/x');
  await page.click('button:has-text("Testar")');
  await page.waitForFunction(() => document.body.innerText.includes('teste enviado'), null, { timeout: 5000 });
  check('teste do webhook confirma', true);

  // 4) executar (step loop mockado) — esperar a CONTAGEM da run atual (o histórico já traz "separadas")
  await page.click('button:has-text("Executar análise")');
  await page.waitForFunction(() => document.body.innerText.includes('2 notícias separadas'), null, { timeout: 15000 });
  const body = await page.locator('body').innerText();
  check('run conclui e mostra separadas', body.includes('2 notícias separadas'));
  check('lista de matches renderiza', body.includes('MCP servers in practice') && body.includes('AI agents take over CI'));
  check('dispatch confirmado', body.includes('2 notícias disparadas para o webhook'));
  await page.screenshot({ path: path.join(outDir, 'admin-03-run.png'), fullPage: true });

  // 5) histórico
  check('histórico mostra a run noturna anterior', body.includes('noturna'));
} catch (err) {
  fails.push(`exceção: ${err.message}`);
  await page.screenshot({ path: path.join(outDir, 'admin-99-error.png'), fullPage: true }).catch(() => {});
  console.error(err);
} finally {
  await browser.close();
  kill();
}

if (fails.length) {
  console.error(`\nFAIL (${fails.length}): ${fails.join(' | ')}`);
  process.exit(1);
}
console.log('\nadmin smoke: TUDO OK — screenshots em webapp/scripts/out/');
