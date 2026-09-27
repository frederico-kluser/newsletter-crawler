// Gabarito v3 da busca (eval/golden.v3.json, chaveado por URL) + loader (eval/golden.mjs).
// O schema é validado SEM banco (roda em qualquer máquina/CI). A resolução URL→id é testada contra um
// SQLite em memória; o teste contra o banco real é OPT-IN (GOLDEN_DB_PATH) e pula sem o acervo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  readGolden, validateGolden, resolveGolden, loadGolden, toLegacyShape, gtRelation,
  titleSimilarity, defaultDbPath, RELATIONS, GOLDEN_V3_PATH, MAX_UNRESOLVED_FRAC,
} from '../eval/golden.mjs';
import { normalizeUrl } from '../src/util.js';

const golden = readGolden();
const clone = () => JSON.parse(JSON.stringify(golden));

// Banco em memória com o schema mínimo que o loader lê (articles.id/url/title).
function memDb(rows) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE articles (id INTEGER PRIMARY KEY, url TEXT UNIQUE, title TEXT)');
  const ins = db.prepare('INSERT INTO articles (id, url, title) VALUES (?, ?, ?)');
  rows.forEach((r) => ins.run(r.id, r.url, r.title));
  return db;
}
const poolRows = (g, { skip = 0 } = {}) => g.pool.slice(skip).map((p, i) => ({ id: 1000 + skip + i, url: p.url, title: p.title }));

// ---- schema (sem DB) ----

test('golden.v3.json passa no validateGolden (schema v3 completo)', () => {
  const v = validateGolden(golden);
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
  assert.equal(golden.version, 3);
});

test('todo cenário tem query, lang, foco ⊆ pool e labels ⊆ pool com relação do enum', () => {
  const poolUrls = new Set(golden.pool.map((p) => p.url));
  assert.ok(golden.scenarios.length >= 6, 'esperados ~6 cenários');
  for (const s of golden.scenarios) {
    assert.ok(s.query && s.query.trim(), `${s.id} sem query`);
    assert.ok(['pt', 'en'].includes(s.lang), `${s.id} lang`);
    assert.ok(s.pool.length >= 10, `${s.id}: foco com ~12 candidatos`);
    for (const u of s.pool) assert.ok(poolUrls.has(u), `${s.id} foco fora do pool: ${u}`);
    for (const [u, rel] of Object.entries(s.labels)) {
      assert.ok(poolUrls.has(u), `${s.id} label fora do pool: ${u}`);
      assert.ok(RELATIONS.includes(rel), `${s.id} relação inválida: ${rel}`);
    }
    // matriz completa: todo cenário rotula toda URL do pool global (o foco inclusive)
    assert.equal(Object.keys(s.labels).length, poolUrls.size, `${s.id} matriz incompleta`);
    const focusRels = new Set(s.pool.map((u) => s.labels[u]));
    for (const rel of ['direct', 'none']) assert.ok(focusRels.has(rel), `${s.id}: foco sem ${rel}`);
  }
});

test('pool: URLs únicas, já normalizadas (a forma de articles.url) e kindTool ⊆ pool', () => {
  const urls = golden.pool.map((p) => p.url);
  assert.equal(new Set(urls).size, urls.length);
  for (const u of urls) assert.equal(normalizeUrl(u), u);
  const poolUrls = new Set(urls);
  assert.ok(golden.kindTool.length > 0);
  for (const u of golden.kindTool) assert.ok(poolUrls.has(u), `kindTool fora do pool: ${u}`);
  // o foco de cada cenário foi montado para ele: pickedFor bate com o foco
  for (const s of golden.scenarios) for (const u of s.pool) {
    assert.equal(golden.pool.find((p) => p.url === u).pickedFor, s.id);
  }
});

test('mistura PT-BR e EN, e o _note registra a proveniência', () => {
  const langs = new Set(golden.scenarios.map((s) => s.lang));
  assert.ok(langs.has('pt') && langs.has('en'));
  assert.match(golden._note, /Claude/);
  assert.match(golden._note, /2026-09-26/);
  assert.equal(golden.createdAt, '2026-09-26');
  assert.ok(golden.source.dbArticles > 0, 'contagem do banco de origem registrada');
});

test('validateGolden acusa label fora do pool, relação fora do enum, query ausente e matriz incompleta', () => {
  const g = clone();
  const s = g.scenarios[0];
  const firstUrl = g.pool[0].url;
  s.labels['https://example.com/nao-esta-no-pool'] = 'direct';
  s.labels[firstUrl] = 'relevant';
  delete s.labels[g.pool[1].url];
  g.scenarios[1].query = '';
  const v = validateGolden(g);
  assert.equal(v.ok, false);
  const all = v.errors.join('\n');
  assert.match(all, /label fora do pool global/);
  assert.match(all, /relação inválida "relevant"/);
  assert.match(all, /sem rótulo/);
  assert.match(all, /sem query/);
});

test('validateGolden acusa URL não normalizada, duplicada e kindTool fora do pool', () => {
  const g = clone();
  g.pool.push({ ...g.pool[0] });
  g.pool.push({ url: 'https://Example.com/x/?utm_source=a', title: 't' });
  g.kindTool.push('https://example.com/fora');
  const v = validateGolden(g);
  const all = v.errors.join('\n');
  assert.match(all, /duplicada/);
  assert.match(all, /não normalizada/);
  assert.match(all, /kindTool fora do pool/);
});

test('validateGolden nunca lança em entrada lixo', () => {
  for (const x of [null, 42, 'x', [], {}, { version: 3, pool: [], scenarios: [] }]) {
    const v = validateGolden(x);
    assert.equal(v.ok, false);
    assert.ok(v.errors.length > 0);
  }
});

// ---- resolução URL -> id (SQLite em memória) ----

test('resolveGolden: mapeia URL→id atual, deriva direct/similar e respeita a matriz', () => {
  const db = memDb(poolRows(golden));
  const r = resolveGolden(golden, db);
  assert.equal(r.report.resolved, golden.pool.length);
  assert.deepEqual(r.report.unresolved, []);
  assert.deepEqual(r.report.titleMismatch, []);
  const s1 = r.scenarios[0];
  const g1 = golden.scenarios[0];
  const idOf = (u) => r.byUrl.get(u).id;
  const directUrls = Object.keys(g1.labels).filter((u) => g1.labels[u] === 'direct');
  assert.deepEqual(new Set(s1.direct), new Set(directUrls.map(idOf)));
  assert.equal(s1.labels.size, golden.pool.length);
  assert.equal(gtRelation(s1, idOf(directUrls[0])), 'direct');
  assert.equal(gtRelation(s1, 999999), 'none'); // fora do pool = none (regra do v2)
  assert.equal(r.kindTool.size, golden.kindTool.length);
  db.close();
});

test('resolveGolden: casa URL com variação (utm/barra final) e caixa do path', () => {
  const g = clone();
  const [a, b] = g.pool;
  const rows = poolRows(g);
  rows[0].url = `${a.url}/?utm_source=newsletter`; // normalizeUrl remove utm_ e a barra final
  const u = new URL(b.url);
  rows[1].url = `${u.origin}${u.pathname.toUpperCase()}${u.search}`; // caixa do path diferente
  const db = memDb(rows);
  const r = resolveGolden(g, db);
  assert.equal(r.report.resolved, g.pool.length);
  assert.equal(r.report.via.normalized, 1);
  assert.equal(r.report.via.loose, 1);
  db.close();
});

test('resolveGolden: até 10% não resolvido passa (e some do resultado); acima disso LANÇA', () => {
  const g = golden;
  const okSkip = Math.floor(g.pool.length * MAX_UNRESOLVED_FRAC);
  let db = memDb(poolRows(g, { skip: okSkip }));
  const r = resolveGolden(g, db);
  assert.equal(r.report.unresolved.length, okSkip);
  assert.equal(r.poolIds.length, g.pool.length - okSkip);
  for (const s of r.scenarios) for (const id of s.labels.keys()) assert.ok(r.poolIds.includes(id));
  db.close();

  db = memDb(poolRows(g, { skip: okSkip + 1 }));
  assert.throws(() => resolveGolden(g, db), (e) => e.code === 'GOLDEN_UNRESOLVED' && e.unresolved.length === okSkip + 1);
  db.close();
});

test('resolveGolden: título muito diferente vira aviso (titleMismatch), não erro', () => {
  const rows = poolRows(golden);
  rows[0].title = 'Receita de bolo de cenoura com cobertura';
  const db = memDb(rows);
  const r = resolveGolden(golden, db);
  assert.equal(r.report.titleMismatch.length, 1);
  assert.equal(r.report.titleMismatch[0].url, golden.pool[0].url);
  db.close();
});

test('toLegacyShape: formato do golden.json v2 (ids) para o harness antigo', () => {
  const db = memDb(poolRows(golden));
  const r = resolveGolden(golden, db);
  const legacy = toLegacyShape(r);
  assert.equal(legacy.pool.length, golden.pool.length);
  assert.equal(legacy.scenarios.length, golden.scenarios.length);
  for (const s of legacy.scenarios) {
    assert.ok(Array.isArray(s.direct) && Array.isArray(s.similar));
    for (const id of [...s.direct, ...s.similar]) assert.ok(legacy.pool.includes(id));
  }
  const focus = toLegacyShape(r, { focusOnly: true });
  for (const s of focus.scenarios) for (const id of [...s.direct, ...s.similar]) assert.ok(s.pool.includes(id));
  db.close();
});

test('titleSimilarity: igual = 1, disjunto = 0, ignora acento e caixa', () => {
  assert.equal(titleSimilarity('Três Novidades do Postgres', 'tres novidades do postgres'), 1);
  assert.equal(titleSimilarity('async rust tokio', 'receita de bolo'), 0);
});

test('loadGolden lança GOLDEN_INVALID com a lista de erros para arquivo inválido', async (t) => {
  const bad = clone();
  bad.scenarios[0].labels[bad.pool[0].url] = 'talvez';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'golden.json');
  fs.writeFileSync(file, JSON.stringify(bad));
  const db = memDb(poolRows(golden));
  await assert.rejects(loadGolden({ file, db }), (e) => e.code === 'GOLDEN_INVALID' && e.errors.length > 0);
  db.close();
});

test('defaultDbPath: EVAL_SOURCE_DB, senão NC_HOME/crawler.db — o DB_PATH (ledger do eval) é IGNORADO', () => {
  // Sob ledgerEnv() o filho do eval tem DB_PATH = o ledger isolado (sem artigos): o golden resolvido
  // contra ele daria GOLDEN_UNRESOLVED. Mesma regra do resolveSourceDb (sample.mjs).
  const ledger = path.resolve('eval/jev/.ledger.db');
  assert.equal(defaultDbPath({ EVAL_SOURCE_DB: 'x/source.db', DB_PATH: ledger }), path.resolve('x/source.db'));
  assert.equal(defaultDbPath({ NC_HOME: '/tmp/nc-h', DB_PATH: ledger }), path.join('/tmp/nc-h', 'crawler.db'));
  assert.equal(defaultDbPath({ DB_PATH: ledger }), path.join(os.homedir(), '.newsletter-crawler', 'crawler.db'));
});

// ---- banco real (OPT-IN: só com GOLDEN_DB_PATH explícito) ----
// Fora do `npm test` padrão de propósito: a suíte não encosta no NC_HOME real (mesma regra do
// nc-home-isolation). Mesmo read-only, abrir o crawler.db do usuário (WAL) deixa os sidecars
// -wal/-shm para trás (conexão read-only não faz o checkpoint de fechamento) e amarra o resultado
// ao estado da máquina (um `remove`/`purge` de fonte derrubaria o teste). Para rodar:
//   GOLDEN_DB_PATH=~/.newsletter-crawler/crawler.db node --test test/eval.golden.test.js
// (ou `node eval/golden.mjs`, que imprime o relatório de resolução).

test('banco real: o pool do golden resolve (≤10% faltando)', async (t) => {
  const dbPath = process.env.GOLDEN_DB_PATH;
  if (!dbPath) return t.skip(`opt-in: defina GOLDEN_DB_PATH (ex.: ${defaultDbPath()})`);
  if (!fs.existsSync(dbPath)) return t.skip(`sem banco em ${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  t.after(() => db.close());
  let n = 0;
  try {
    n = db.prepare('SELECT COUNT(*) AS n FROM articles').get().n;
  } catch {
    return t.skip('banco sem a tabela articles');
  }
  if (n < 1000) return t.skip(`banco sem o acervo (${n} artigos)`);
  const r = await loadGolden({ file: GOLDEN_V3_PATH, db });
  assert.ok(r.report.unresolvedFrac <= MAX_UNRESOLVED_FRAC, `não resolvidas: ${r.report.unresolved.join(', ')}`);
  assert.equal(r.scenarios.length, golden.scenarios.length);
});
