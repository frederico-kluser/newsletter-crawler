// Recuperação LÉXICA (FTS5/BM25): sanitização do MATCH, ranqueamento por BM25 (título pesa mais),
// stemming (porter) e escopo por fonte. NC_HOME temporário ANTES do import (config.js lê no load).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-fts-'));

const { db } = await import('../src/db.js');
const { toFtsMatch, retrieveLexical, prefilterCandidates, fuseRRF, hybridCandidates } = await import('../src/retrieval.js');

after(() => rmSync(process.env.NC_HOME, { recursive: true, force: true }));

// FK on: as fontes precisam existir antes dos artigos.
db.prepare(`INSERT INTO sources (id, name, base_url) VALUES (1, 'S1', 'https://s1')`).run();
db.prepare(`INSERT INTO sources (id, name, base_url) VALUES (2, 'S2', 'https://s2')`).run();

function addArticle({ id, source_id = 1, title, content, title_pt = null, summary_pt = null }) {
  db.prepare(
    `INSERT INTO articles (id, source_id, url, title, content, title_pt, summary_pt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, source_id, `https://x.test/${id}`, title, content, title_pt, summary_pt);
}

test('toFtsMatch: sanitiza operadores/caracteres, cita termos e ignora consulta vazia', () => {
  assert.equal(toFtsMatch('   '), null);
  assert.equal(toFtsMatch('()-"*:'), null); // nenhum token de letra/número
  assert.equal(toFtsMatch('postgres AND vector'), '"postgres" OR "and" OR "vector"'); // AND vira literal
  assert.equal(toFtsMatch('C++ e Rust'), '"rust"'); // "c" e "e" (len 1) caem no filtro >=2
});

test('BM25 ranqueia por relevância, com título pesando mais que o corpo', () => {
  addArticle({ id: 1, title: 'Postgres vector search with sqlite', content: 'Lorem ipsum about databases.' });
  addArticle({ id: 2, title: 'Unrelated cooking recipe', content: 'A long article that mentions postgres once.' });
  addArticle({ id: 3, title: 'Cats and dogs', content: 'Nothing relevant here at all.' });
  const ids = retrieveLexical('postgres vector', { limit: 10 }).map((h) => h.id);
  assert.ok(ids.includes(1), 'match no título entra no resultado');
  assert.equal(ids[0], 1, 'match no título ranqueia acima de match só no corpo');
  assert.ok(!ids.includes(3), 'sem nenhum match não entra');
});

test('stemming (porter): "running" recupera um doc com "run"', () => {
  addArticle({ id: 4, title: 'How to run a marathon', content: 'training tips' });
  assert.ok(
    retrieveLexical('running', { limit: 10 }).some((h) => h.id === 4),
    'stemming casa run/running',
  );
});

test('escopo por fonte filtra o resultado', () => {
  addArticle({ id: 5, source_id: 2, title: 'postgres tips in source two', content: 'x' });
  const all = retrieveLexical('postgres', { limit: 10 }).map((h) => h.id);
  const scoped = retrieveLexical('postgres', { limit: 10, sources: [2] }).map((h) => h.id);
  assert.ok(all.includes(5) && all.includes(1), 'sem escopo, artigos de ambas as fontes');
  assert.deepEqual(scoped, [5], 'com escopo, só a fonte 2');
});

test('índice fica coerente após DELETE (trigger de sync)', () => {
  db.prepare(`DELETE FROM articles WHERE id = 5`).run();
  assert.ok(
    !retrieveLexical('postgres', { limit: 10 }).some((h) => h.id === 5),
    'artigo deletado sai do índice',
  );
});

test('prefilterCandidates: corta p/ top-K por BM25 quando escopo > k; senão mantém intacto', () => {
  for (let i = 10; i <= 15; i++) {
    addArticle({ id: i, title: i <= 12 ? 'kubernetes deployment guide' : 'gardening for beginners', content: 'x' });
  }
  const rows = [10, 11, 12, 13, 14, 15].map((id) => ({ id }));
  // escopo (6) > k (2) e a consulta casa 10/11/12 -> top-2 DESSES (nunca os que não casam)
  const pf = prefilterCandidates(rows, 'kubernetes', { k: 2 });
  assert.equal(pf.prefiltered, true);
  assert.equal(pf.scope, 6);
  assert.equal(pf.rows.length, 2);
  assert.ok(pf.rows.every((r) => [10, 11, 12].includes(r.id)), 'só candidatos que casam entram');
  // escopo <= k -> não filtra (recall pleno)
  const pf2 = prefilterCandidates(rows, 'kubernetes', { k: 100 });
  assert.equal(pf2.prefiltered, false);
  assert.equal(pf2.rows.length, 6);
  // consulta vazia -> não filtra (fail-open)
  assert.equal(prefilterCandidates(rows, '  ', { k: 2 }).prefiltered, false);
});

test('fuseRRF: soma 1/(k+rank); item bem colocado nas duas listas vence; keep filtra escopo', () => {
  const a = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const b = [{ id: 2 }, { id: 3 }, { id: 9 }];
  const ids = fuseRRF([a, b], { k: 60 }).map((f) => f.id);
  assert.equal(ids[0], 2, 'id 2 (topo em b, 2º em a) vence a fusão');
  assert.ok(ids.includes(9), 'id presente em só uma lista ainda entra');
  const kept = fuseRRF([a, b], { k: 60, keep: new Set([1, 2, 3]) }).map((f) => f.id);
  assert.ok(!kept.includes(9), 'keep remove id fora do escopo');
});

test('hybridCandidates: base sem vetores cai p/ só-léxico (mode=lexical), SEM carregar o modelo', async () => {
  const rows = [10, 11, 12, 13, 14, 15].map((id) => ({ id })); // kubernetes 10-12 (do teste acima)
  const pf = await hybridCandidates(rows, 'kubernetes', { k: 2 });
  assert.equal(pf.prefiltered, true);
  assert.equal(pf.mode, 'lexical', 'sem embeddings na base, não baixa modelo — usa só o FTS');
  assert.equal(pf.rows.length, 2);
  assert.ok(pf.rows.every((r) => [10, 11, 12].includes(r.id)));
  assert.equal((await hybridCandidates(rows, 'kubernetes', { k: 100 })).prefiltered, false, 'escopo <= k não filtra');
});
