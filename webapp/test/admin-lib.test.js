// Testes OFFLINE das peças puras do backend do /admin: sessão HMAC, guarda de credenciais/cron,
// validação do webhook (anti-SSRF), assinatura do payload, sanitização da config e o escopo/
// batches/payload da análise (paridade com o filtro do site).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCredentials, clearCookieHeader, cookieHeader, parseCookies, requireAdmin, requireCron, signSession, verifySession, SESSION_COOKIE } from '../api/_lib/auth.js';
import { sanitizeConfigPatch } from '../api/admin/config.js';
import { signPayload, validateWebhookUrl } from '../api/_lib/dispatch.js';
import { payloadItem, planBatches, resolveScope } from '../api/_lib/analyze.js';
import { buildBatchQuestions, buildBatchState, batchBudgetLeft, verdictFor } from '../api/_lib/jev.js';

const SECRETS = { user: 'admin', password: 's3nh4-f0rt3', sessionSecret: 'sess-secret', webhookSecret: 'whsec', cronSecret: 'cron-secret' };

test('sessão HMAC: assinar/verificar; adulteração/expiração caem fora', () => {
  const { value, exp } = signSession(SECRETS.sessionSecret, 1000, 60000);
  assert.ok(exp === 61000);
  assert.ok(verifySession(value, SECRETS.sessionSecret, 1001));
  assert.ok(!verifySession(value, 'outra-chave', 1001), 'chave errada não valida');
  assert.ok(!verifySession(`${value}x`, SECRETS.sessionSecret, 1001), 'assinatura adulterada não valida');
  const parts = value.split('.');
  assert.ok(!verifySession(`v1.${Number(parts[1]) + 1}.${parts[2]}`, SECRETS.sessionSecret, 1001), 'exp editado invalida a assinatura');
  assert.ok(!verifySession(value, SECRETS.sessionSecret, 61001), 'sessão expirada não valida');
  assert.ok(!verifySession(undefined, SECRETS.sessionSecret));
  assert.ok(!verifySession('lixo', SECRETS.sessionSecret));
});

test('cookie: HttpOnly+Secure+SameSite=Strict; parser ignora ruído', () => {
  const c = cookieHeader('abc.def.ghi', 60);
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(clearCookieHeader(), /Max-Age=0/);
  const req = { headers: { cookie: `x=1; ${SESSION_COOKIE}=v; y = 2` } };
  assert.equal(parseCookies(req)[SESSION_COOKIE], 'v');
  assert.equal(parseCookies({ headers: {} })[SESSION_COOKIE], undefined);
});

test('credenciais: comparação exata; requireAdmin 503 sem env e 401 sem cookie', () => {
  assert.ok(checkCredentials('admin', 's3nh4-f0rt3', SECRETS));
  assert.ok(!checkCredentials('admin', 'errada', SECRETS));
  assert.ok(!checkCredentials('Admin', 's3nh4-f0rt3', SECRETS));
  assert.ok(!checkCredentials(undefined, undefined, SECRETS));

  const req = { headers: { cookie: `${SESSION_COOKIE}=qualquer` } };
  const missing = requireAdmin(req, { ...SECRETS, sessionSecret: '' });
  assert.equal(missing.status, 503);
  const unauthorized = requireAdmin(req, SECRETS);
  assert.equal(unauthorized.status, 401);
  const { value } = signSession(SECRETS.sessionSecret);
  const ok = requireAdmin({ headers: { cookie: `${SESSION_COOKIE}=${value}` } }, SECRETS);
  assert.deepEqual(ok, { ok: true });
});

test('cron: Bearer CRON_SECRET exato; sem secret → 503; token errado → 401', () => {
  assert.deepEqual(requireCron({ headers: { authorization: 'Bearer cron-secret' } }, SECRETS), { ok: true });
  assert.equal(requireCron({ headers: { authorization: 'Bearer errado' } }, SECRETS).status, 401);
  assert.equal(requireCron({ headers: {} }, { ...SECRETS, cronSecret: '' }).status, 503);
});

test('webhook: só http(s) público — localhost/link-local/privados bloqueados', () => {
  assert.equal(validateWebhookUrl('https://hooks.exemplo.com/x').ok, true);
  assert.equal(validateWebhookUrl('http://example.org/hook').ok, true);
  assert.equal(validateWebhookUrl('').ok, true, 'vazio = sem webhook (ok, decide quem chama)');
  for (const bad of [
    'ftp://example.org/x',
    'não é url',
    'http://localhost/hook',
    'http://127.0.0.1:3000/hook',
    'http://10.0.0.5/hook',
    'http://192.168.1.10/hook',
    'http://172.16.0.1/hook',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/hook',
    'http://printer.local/hook',
    'http://metadata.google.internal/computeMetadata/v1/',
  ]) {
    assert.equal(validateWebhookUrl(bad).ok, false, `${bad} devia ser bloqueado`);
  }
});

test('assinatura do payload: HMAC-SHA256 estável e sensível ao segredo', () => {
  const body = JSON.stringify([{ id: 1 }]);
  const a = signPayload(body, 'whsec');
  const b = signPayload(body, 'whsec');
  assert.equal(a, b);
  assert.match(a, /^sha256=[0-9a-f]{64}$/);
  assert.notEqual(a, signPayload(body, 'outro'));
  assert.notEqual(a, signPayload(JSON.stringify([{ id: 2 }]), 'whsec'));
});

test('sanitizeConfigPatch: valida input/datas/limiar/kind/fontes/webhook', () => {
  assert.deepEqual(sanitizeConfigPatch({ input: 'agentes de IA' }).patch, { input: 'agentes de IA' });
  assert.equal(sanitizeConfigPatch({ input: 'x'.repeat(2001) }).ok, false);
  assert.deepEqual(sanitizeConfigPatch({ from: '2026-01-01', to: '' }).patch, { from: '2026-01-01', to: '' });
  assert.equal(sanitizeConfigPatch({ from: '01/01/2026' }).ok, false);
  assert.equal(sanitizeConfigPatch({ from: '2026-02-01', to: '2026-01-01' }).ok, false, 'início depois do fim');
  assert.equal(sanitizeConfigPatch({ threshold: 1.2 }).ok, false);
  assert.deepEqual(sanitizeConfigPatch({ threshold: 0.7 }).patch, { threshold: 0.7 });
  assert.equal(sanitizeConfigPatch({ kind: 'podcast' }).ok, false);
  assert.deepEqual(sanitizeConfigPatch({ sourceIds: [3, 'x', 3, -1, 2.5] }).patch, { sourceIds: [3] });
  assert.equal(sanitizeConfigPatch({ webhookUrl: 'http://127.0.0.1/x' }).ok, false);
  assert.deepEqual(sanitizeConfigPatch({ webhookUrl: 'https://hooks.exemplo.com/x' }).patch, {
    webhookUrl: 'https://hooks.exemplo.com/x',
  });
});

// ---- escopo/batches/payload ----

const ARTICLES = [
  { id: 1, source_id: 1, date_iso: '2026-09-01', kind: 'news', verify_status: 'ok', title: 'A', summary_pt: 'a' },
  { id: 2, source_id: 2, date_iso: '2026-09-05', kind: 'news', verify_status: 'ok', title: 'B', summary_pt: 'b' },
  { id: 3, source_id: 1, date_iso: '2026-08-01', kind: 'release', verify_status: 'ok', title: 'C', summary_pt: 'c' },
  { id: 4, source_id: 1, date_iso: '2026-09-05', kind: 'news', verify_status: 'junk', title: 'D', summary_pt: 'd' },
  { id: 5, source_id: 3, date_iso: '2026-09-30', kind: 'news', verify_status: 'ok', title: 'E', summary_pt: 'e' },
];
const META = { sources: [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }, { id: 3, name: 'Gama' }], toolContentTypes: [] };

test('resolveScope: MESMA semântica do site — from/to em date_iso, fontes em OR, junk fora', () => {
  const all = resolveScope(ARTICLES, META, { from: '', to: '', sourceIds: [], kind: 'all' });
  assert.deepEqual(all.map((a) => a.id), [5, 2, 1, 3], 'data DESC, id ASC dentro da data; junk (4) fora');

  const period = resolveScope(ARTICLES, META, { from: '2026-09-01', to: '2026-09-05', sourceIds: [], kind: 'all' });
  assert.deepEqual(period.map((a) => a.id), [2, 1]);

  const bySource = resolveScope(ARTICLES, META, { from: '', to: '', sourceIds: [1], kind: 'all' });
  assert.deepEqual(bySource.map((a) => a.id), [1, 3], 'só fonte 1');

  const releases = resolveScope(ARTICLES, META, { from: '', to: '', sourceIds: [], kind: 'release' });
  assert.deepEqual(releases.map((a) => a.id), [3]);
});

test('planBatches: respeita o tamanho e não estoura o orçamento do jev-core', () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, title: `t${i}`, summary_pt: 's'.repeat(200) }));
  const batches = planBatches(items, { input: 'IA', batchSize: 3 });
  assert.equal(batches.length, 3, '7 itens em lotes de 3 → 3+3+1');
  assert.equal(batches[2].items.length, 1);
  for (const b of batches) {
    const state = buildBatchState(b.items);
    const questions = buildBatchQuestions('IA', b.items.length);
    assert.ok(batchBudgetLeft(state, questions) >= 0, 'cada batch cabe no orçamento');
  }
});

test('buildBatchState/Questions: state numerado, 1 noul por artigo + guarda de injeção ancorada', () => {
  const state = buildBatchState([{ title: 'Título', title_pt: 'Título PT', summary_pt: 'Resumo' }]);
  assert.deepEqual(state.articles[0], { n: 1, title: 'Título', title_pt: 'Título PT', summary: 'Resumo' });
  const q = buildBatchQuestions('agentes de IA', 2);
  assert.deepEqual(Object.keys(q), ['q1', 'q2', 'injection']);
  assert.equal(q.q1.type, 'noul');
  assert.match(q.q1.instructions, /agentes de IA/);
  assert.match(q.q1.instructions, /untrusted web content/i, 'âncora de não-confiança presente');
  assert.ok(q.q1.criteria.true && q.q1.criteria.false);
});

test('verdictFor: p ≥ limiar separa; resposta em falta = uncertain; pOf complementar no false', () => {
  const parsed = { q1: { type: 'noul', noul: 0.8 }, q2: { type: 'noul', noul: 0.2 } };
  assert.deepEqual(verdictFor(parsed, 'q1', 0.5), { p: 0.8, decision: 'yes' });
  assert.deepEqual(verdictFor(parsed, 'q2', 0.5), { p: 0.2, decision: 'no' });
  assert.deepEqual(verdictFor(parsed, 'q9', 0.5), { p: null, decision: 'uncertain' });
  assert.deepEqual(verdictFor(parsed, 'q1', 0.9), { p: 0.8, decision: 'no' }, 'limiar mais alto muda a separação');
});

test('payloadItem: metadados + resumo + veredito, SEM corpo', () => {
  const item = payloadItem(ARTICLES[0], 'Alpha', { p: 0.9, decision: 'yes' }, 'typesafe/jev-1.13-x');
  assert.deepEqual(item.source, { id: 1, name: 'Alpha' });
  assert.equal(item.jev.p, 0.9);
  assert.equal(item.jev.model, 'typesafe/jev-1.13-x');
  assert.ok(!('content' in item) && !('body' in item) && !('snippet' in item));
});
