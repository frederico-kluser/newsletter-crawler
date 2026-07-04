// Testes da BUSCA IA da web (`/api/search`, `/api/search/scope`) e da key (`/api/key*`), sem
// LLM nem rede: o motor e o probe entram por `deps` (startWebServer injeta fakes). NC_HOME num
// tmp (schema vazio) + porta efêmera, no padrão do web.api.test.js. O guard do modo profundo é
// forçado baixo via SEARCH_MODE_A_CONFIRM=1 ANTES do import (config lê no load).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-websearch-test-'));
process.env.NC_HOME = NC_HOME_TMP;
process.env.SEARCH_MODE_A_CONFIRM = '1'; // profunda: >1 artigo exige confirm (testável com 3 seeds)

const { stmts, db } = await import('../src/db.js');
const { startWebServer } = await import('../src/web.js');
const { setRuntimeKey, OPENROUTER_API_KEY: KEY_AT_BOOT } = await import('../src/config.js');

// ---- seed (2 fontes, datas distintas p/ o escopo) ----
const alpha = stmts.upsertSource.get({ name: 'Fonte Alpha', base_url: 'http://alpha.test', type: 'listing', max_index_pages: null });
const beta = stmts.upsertSource.get({ name: 'Fonte Beta', base_url: 'http://beta.test', type: 'listing', max_index_pages: null });
function seed({ source, url, title, published, tags = [] }) {
  const r = stmts.insertArticle.run({
    source_id: source.id, url, title, content: `conteúdo de ${title}`,
    content_hash: `hash-${url}`, published_at: published, run_id: null,
    kind: null, issue_url: null, section: null, blurb: null,
    content_source: 'target', cleaned: 0, needs_enrich: 0,
  });
  const id = Number(r.lastInsertRowid);
  tags.forEach(({ facet, tag }, i) => stmts.insertTag.run({ article_id: id, facet, tag, rank: i + 1 }));
  return id;
}
const a1 = seed({ source: alpha, url: 'http://alpha.test/1', title: 'RSC em produção', published: '2026-06-10' });
const a2 = seed({ source: alpha, url: 'http://alpha.test/2', title: 'LLM local barato', published: '2026-06-20' });
const b1 = seed({
  source: beta, url: 'http://beta.test/1', title: 'Vitest 3', published: '2026-06-25',
  tags: [{ facet: 'framework-library-tool', tag: 'vitest' }],
});

// ---- deps fake (controláveis por teste) ----
let searchImpl = async () => ({
  query: 'x', deep: false, scanned: 0, total: 0, relevant: 0, skipped: 0, truncated: false, hits: [],
});
let probeImpl = async () => ({ ok: true, status: 200 });
const srv = await startWebServer({
  port: 0,
  open: false,
  deps: {
    search: (query, opts) => searchImpl(query, opts),
    probeKey: (key) => probeImpl(key),
  },
});
const base = `http://127.0.0.1:${srv.port}`;
const getJSON = async (p) => {
  const r = await fetch(base + p);
  return { status: r.status, body: await r.json() };
};
const postJSON = async (p, body, raw = false) => {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

after(async () => {
  await srv.close();
  db.close();
  setRuntimeKey(KEY_AT_BOOT);
  rmSync(NC_HOME_TMP, { recursive: true, force: true });
});

// ---- preflight de escopo ----
test('scope: contagem respeita fontes (json array) e período', async () => {
  assert.equal((await getJSON('/api/search/scope')).body.count, 3);
  const soAlpha = await getJSON(`/api/search/scope?sources=${encodeURIComponent(JSON.stringify([alpha.id]))}`);
  assert.equal(soAlpha.body.count, 2);
  const periodo = await getJSON('/api/search/scope?from=2026-06-15&to=2026-06-22');
  assert.equal(periodo.body.count, 1); // só a2 (06-20)
  const deep = await getJSON('/api/search/scope?deep=1');
  assert.equal(deep.body.threshold, 1, 'threshold da profunda vem de SEARCH_MODE_A_CONFIRM');
  assert.equal(deep.body.needsConfirm, true, '3 artigos > 1 exige confirmação');
  assert.equal(deep.body.calls, 4, 'profunda: 1 chamada por artigo (3) + 1 de entendimento da consulta (spec)');
  assert.ok(deep.body.estimatedUsd > 0, 'estimativa em US$ presente');
});

test('scope: sources inválido é 400', async () => {
  assert.equal((await getJSON('/api/search/scope?sources=abc')).status, 400);
  assert.equal((await getJSON(`/api/search/scope?sources=${encodeURIComponent('["x"]')}`)).status, 400);
  assert.equal((await getJSON('/api/search/scope?from=not-a-date')).status, 400);
});

// ---- validação do POST ----
test('search: body inválido/grande/sem consulta viram 400/413', async () => {
  setRuntimeKey('sk-or-v1-teste');
  assert.equal((await postJSON('/api/search', '{lixo', true)).status, 400);
  const gigante = JSON.stringify({ query: 'x'.repeat(70 * 1024) });
  assert.equal((await postJSON('/api/search', gigante, true)).status, 413);
  assert.equal((await postJSON('/api/search', { query: '   ' })).status, 400);
});

test('search: sem key é 400 com code NO_KEY (o cliente abre o modal)', async () => {
  setRuntimeKey('');
  const r = await postJSON('/api/search', { query: 'rsc' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'NO_KEY');
});

// ---- guard re-validado no servidor (profunda acima do threshold exige confirm) ----
test('search: profunda acima do guard sem confirm é 428; com confirm roda', async () => {
  setRuntimeKey('sk-or-v1-teste');
  const sem = await postJSON('/api/search', { query: 'rsc', deep: true });
  assert.equal(sem.status, 428);
  assert.equal(sem.body.needsConfirm, true);
  assert.equal(sem.body.count, 3);

  searchImpl = async (query, opts) => {
    assert.equal(opts.deep, true, 'deep chega ao motor');
    return { query, deep: true, scanned: 3, total: 3, relevant: 0, skipped: 0, truncated: false, hits: [] };
  };
  const com = await postJSON('/api/search', { query: 'rsc', deep: true, confirm: true });
  assert.equal(com.status, 200);
  assert.equal(com.body.total, 3);
});

// ---- escopo repassado + enriquecimento p/ os cards ----
test('search: escopo chega ao motor e os hits voltam enriquecidos na ordem da relevância', async () => {
  setRuntimeKey('sk-or-v1-teste');
  let got = null;
  searchImpl = async (query, opts) => {
    got = { query, ...opts };
    return {
      query, deep: false, scanned: 3, total: 3, relevant: 2, skipped: 0, truncated: false,
      hits: [
        { id: b1, relation: 'direct', kind: 'tool' },
        { id: a1, relation: 'similar', kind: 'news' },
      ],
    };
  };
  const r = await postJSON('/api/search', { query: 'test runner', from: '2026-06-01' });
  assert.equal(r.status, 200);
  assert.deepEqual(got.sources, null);
  assert.equal(got.from, '2026-06-01');
  assert.deepEqual(r.body.items.map((i) => i.id), [b1, a1], 'ordem da relevância preservada');
  const first = r.body.items[0];
  assert.equal(first.source_name, 'Fonte Beta', 'card ganha o label da fonte');
  assert.equal(first.relation, 'direct');
  assert.equal(first.judge_kind, 'tool');
  assert.deepEqual(first.tags['framework-library-tool'], ['vitest'], 'decoração de tags igual ao browse');
  assert.equal(r.body.items[1].relation, 'similar');
});

test('search: escopo vazio devolve 200 sem chamar o motor', async () => {
  setRuntimeKey('sk-or-v1-teste');
  searchImpl = async () => {
    throw new Error('não deveria ser chamado');
  };
  const r = await postJSON('/api/search', { query: 'rsc', from: '2030-01-01' });
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 0);
  assert.deepEqual(r.body.items, []);
});

// ---- serialização: UMA busca por vez ----
test('search: busca concorrente leva 409; depois de terminar, passa de novo', async () => {
  setRuntimeKey('sk-or-v1-teste');
  let release;
  searchImpl = () =>
    new Promise((resolve) => {
      release = () =>
        resolve({ query: 'x', deep: false, scanned: 1, total: 1, relevant: 0, skipped: 0, truncated: false, hits: [] });
    });
  const primeira = postJSON('/api/search', { query: 'lenta' });
  await new Promise((r) => setTimeout(r, 80)); // deixa a 1ª entrar na seção crítica
  const segunda = await postJSON('/api/search', { query: 'concorrente' });
  assert.equal(segunda.status, 409);
  release();
  assert.equal((await primeira).status, 200);
  searchImpl = async (query) => ({ query, deep: false, scanned: 1, total: 1, relevant: 0, skipped: 0, truncated: false, hits: [] });
  assert.equal((await postJSON('/api/search', { query: 'depois' })).status, 200, 'flag de ocupado liberou');
});

// ---- key: status dinâmico + POST valida antes de salvar ----
test('key: status reflete o runtime; POST com probe ok persiste em NC_HOME/.env e ativa na hora', async () => {
  setRuntimeKey('');
  assert.equal((await getJSON('/api/key/status')).body.hasKey, false);

  probeImpl = async () => ({ ok: false, status: 401 });
  const ruim = await postJSON('/api/key', { key: 'sk-or-v1-invalida' });
  assert.equal(ruim.status, 200);
  assert.equal(ruim.body.ok, false);
  assert.equal((await getJSON('/api/key/status')).body.hasKey, false, 'key ruim NÃO ativa');
  const envPath = path.join(NC_HOME_TMP, '.env');
  assert.ok(!existsSync(envPath) || !readFileSync(envPath, 'utf8').includes('invalida'), 'key ruim NÃO é salva');

  probeImpl = async () => ({ ok: true, status: 200 });
  const boa = await postJSON('/api/key', { key: 'sk-or-v1-valida' });
  assert.equal(boa.body.ok, true);
  assert.ok(readFileSync(envPath, 'utf8').includes('OPENROUTER_API_KEY=sk-or-v1-valida'), 'persistida no .env');
  assert.equal((await getJSON('/api/key/status')).body.hasKey, true, 'ativa SEM reiniciar o servidor');

  assert.equal((await postJSON('/api/key', { key: '' })).status, 400, 'key vazia é 400');
});
