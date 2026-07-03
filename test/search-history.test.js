// Histórico de buscas (tabela `searches`): helpers de comando (list/get/delete com re-hidratação
// dos hits congelados e contagem de ausentes) + os endpoints HTTP do buscador local. NC_HOME
// aponta p/ um diretório temporário ANTES dos imports (schema nasce vazio); sem LLM/rede.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-hist-test-'));
process.env.NC_HOME = NC_HOME_TMP;

const { stmts, db } = await import('../src/db.js');
const { listSearchHistory, getSearchHistoryEntry, deleteSearchHistory } = await import('../src/commands.js');
const { startWebServer } = await import('../src/web.js');

// ---- seed: 2 artigos reais + 1 id fantasma nos hits ----
const src = stmts.upsertSource.get({ name: 'Fonte Hist', base_url: 'http://hist.test', type: 'listing', max_index_pages: null });

function seedArticle({ url, title, content, published }) {
  const r = stmts.insertArticle.run({
    source_id: src.id,
    url,
    title,
    content,
    content_hash: `hash-${url}`,
    published_at: published,
    run_id: null,
    kind: null,
    issue_url: null,
    section: null,
    blurb: null,
    content_source: 'target',
    cleaned: 0,
    needs_enrich: 0,
  });
  return Number(r.lastInsertRowid);
}

const a1 = seedArticle({ url: 'http://hist.test/n1', title: 'Notícia Um', content: 'corpo da notícia um', published: '2026-06-20' });
const a2 = seedArticle({ url: 'http://hist.test/t1', title: 'Tool Um', content: 'corpo da tool um', published: '2026-06-21' });

const searchId = Number(
  stmts.insertSearch.run({
    run_id: null,
    origin: 'cli',
    query: 'consulta salva',
    mode: 'A',
    scope_json: JSON.stringify({ all: true, runId: null }),
    stats_json: JSON.stringify({ scanned: 3, total: 3, relevant: 3, skipped: 0 }),
    // a1 com bucket explícito (CLI), a2 no estilo web (sem bucket; kind decide) e um id fantasma
    hits_json: JSON.stringify([
      { id: a1, relation: 'direct', kind: 'news', score: 'direct', bucket: 'noticias' },
      { id: a2, relation: 'similar', kind: 'tool' },
      { id: 99999, relation: 'direct', kind: 'news', bucket: 'noticias' },
    ]),
  }).lastInsertRowid,
);

test('listSearchHistory parseia escopo/stats e traz custo', () => {
  const list = listSearchHistory();
  assert.equal(list.length, 1);
  const e = list[0];
  assert.equal(e.id, searchId);
  assert.equal(e.query, 'consulta salva');
  assert.equal(e.mode, 'A');
  assert.equal(e.scope.all, true);
  assert.equal(e.stats.relevant, 3);
  assert.equal(typeof e.spent_usd, 'number');
});

test('getSearchHistoryEntry re-hidrata buckets, conta ausentes e mantém o shape da ResultsView', () => {
  const r = getSearchHistoryEntry(searchId);
  assert.equal(r.query, 'consulta salva');
  assert.equal(r.mode, 'A');
  assert.equal(r.missing, 1); // o id fantasma não quebra, vira contagem
  assert.equal(r.relevant, 2); // só os re-hidratados contam
  assert.equal(r.buckets.noticias.length, 1);
  assert.equal(r.buckets.ferramentas.length, 1); // sem bucket salvo, kind 'tool' decide
  const n = r.buckets.noticias[0];
  assert.equal(n.id, a1);
  assert.equal(n.title, 'Notícia Um');
  assert.equal(n.relation, 'direct');
  assert.ok(n.snippet.includes('corpo da notícia'));
  assert.equal(n.source_name, 'Fonte Hist');
  assert.equal(n.date_iso, '2026-06-20');
});

test('getSearchHistoryEntry devolve null p/ id inexistente', () => {
  assert.equal(getSearchHistoryEntry(424242), null);
});

// ---- endpoints HTTP (servidor real em porta efêmera; deps.search nunca é chamado) ----
const srv = await startWebServer({ port: 0, open: false, deps: { search: async () => ({ hits: [] }) } });
after(async () => {
  await srv.close();
  db.close();
  rmSync(NC_HOME_TMP, { recursive: true, force: true });
});

test('GET /api/searches lista o histórico', async () => {
  const r = await fetch(`${srv.url}/api/searches`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.searches.length, 1);
  assert.equal(body.searches[0].query, 'consulta salva');
  assert.equal(body.searches[0].stats.relevant, 3);
});

test('GET /api/searches/:id re-hidrata cards e conta ausentes', async () => {
  const r = await fetch(`${srv.url}/api/searches/${searchId}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.query, 'consulta salva');
  assert.equal(body.items.length, 2);
  assert.equal(body.missing, 1);
  assert.equal(body.relevant, 2);
  const ids = body.items.map((i) => i.id).sort();
  assert.deepEqual(ids, [a1, a2].sort());
  assert.equal(body.items[0].relation, 'direct'); // veredito congelado preservado no card
});

test('GET /api/searches/:id inexistente -> 404', async () => {
  const r = await fetch(`${srv.url}/api/searches/424242`);
  assert.equal(r.status, 404);
});

test('DELETE /api/searches/:id apaga um item; DELETE /api/searches limpa tudo', async () => {
  const extra = Number(
    stmts.insertSearch.run({
      run_id: null,
      origin: 'web',
      query: 'efêmera',
      mode: 'soft',
      scope_json: '{}',
      stats_json: '{}',
      hits_json: '[]',
    }).lastInsertRowid,
  );
  let r = await fetch(`${srv.url}/api/searches/${extra}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).deleted, 1);
  r = await fetch(`${srv.url}/api/searches/${extra}`, { method: 'DELETE' });
  assert.equal(r.status, 404); // já não existe

  r = await fetch(`${srv.url}/api/searches`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal(stmts.listSearches.all().length, 0);
  assert.equal(deleteSearchHistory(null), 0); // limpar de novo: 0 linhas, sem erro
});

test('DELETE fora do histórico -> 405', async () => {
  const r = await fetch(`${srv.url}/api/meta`, { method: 'DELETE' });
  assert.equal(r.status, 405);
});
