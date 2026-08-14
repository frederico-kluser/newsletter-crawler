// Regressão do bug do `finish`: com a internet fora, a API não responde e o artigo era gravado
// como 'classificado' sem tags (falso-positivo) — e nunca mais re-selecionado. O fix mantém o
// artigo PENDENTE (não persiste) quando uma faceta OBRIGATÓRIA cai por rede/API. Aqui testamos o
// helper puro `failedMandatoryFacets`, que é o critério exato dessa decisão.
// NC_HOME temporário ANTES do import (classify.js -> db.js abre o banco no load).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-classify-'));
const { failedMandatoryFacets } = await import('../src/classify.js');

after(() => rmSync(process.env.NC_HOME, { recursive: true, force: true }));

// ---- model_used provider-aware (onda 2: telemetria reflete o provider ativo) ----
// O `persist` grava model_used na tabela classifications; desde a Onda 1 ele deve ser o slug
// RESOLVIDO do provider (stageModel traduz no call-time), nunca o cru do models.json. Como
// classifyArticleRow chama a API de verdade, o filho roda com --experimental-test-module-mocks
// interceptando classifyFacet (a única chamada LLM) — teste determinístico, sem rede/SDK.
const WIRE_CHILD_SOURCE = `import { mock } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2]; // raiz da worktree (passada pelo teste pai)
const ncHome = mkdtempSync(path.join(tmpdir(), 'nc-classify-wire-'));
process.env.NC_HOME = ncHome;
process.on('exit', () => rmSync(ncHome, { recursive: true, force: true }));
// Env limpo: nada do shell pode vazar p/ a resolução de modelos (mesmo padrão do llm.provider).
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) delete process.env[k];
}
// Intercepta a ÚNICA chamada LLM da classificação (classifyFacet) — sem rede, sem SDK.
mock.module(pathToFileURL(path.join(root, 'src/llm.js')).href, {
  namedExports: {
    classifyFacet: async () => ({ tags: [], uncovered: [], confidence: 0.9 }),
  },
});

const { stmts, db } = await import(pathToFileURL(path.join(root, 'src/db.js')).href);
const { classifyArticleRow } = await import(pathToFileURL(path.join(root, 'src/classify.js')).href);
const config = await import(pathToFileURL(path.join(root, 'src/config.js')).href);

const src = stmts.upsertSource.get({ name: 'Wire', base_url: 'http://wire.test', type: 'listing', max_index_pages: null });

async function classifyOne(urlSuffix, provider, key) {
  const r = stmts.insertArticle.run({
    source_id: src.id, url: 'http://wire.test/' + urlSuffix, title: 'T ' + urlSuffix,
    content: 'corpo', content_hash: 'h-' + urlSuffix, published_at: null, run_id: null, kind: null,
    issue_url: null, section: null, blurb: null, content_source: 'target', cleaned: 0, needs_enrich: 0,
  });
  const id = Number(r.lastInsertRowid);
  const [article] = stmts.listArticlesNeedingClassification.all(-1).filter((a) => a.id === id);
  config.setRuntimeKey(key, provider);
  await classifyArticleRow(article);
  const row = stmts.getClassification.get(id);
  return row ? row.model_used : null;
}

let out = null;
try {
  const deepseek = await classifyOne('a1', 'deepseek', 'sk-ds-teste');
  const openrouter = await classifyOne('a2', 'openrouter', 'sk-or-teste');
  out = JSON.stringify({ deepseek, openrouter });
} catch (e) {
  process.stderr.write(String((e && e.stack) || e));
  process.exitCode = 1;
} finally {
  db.close();
}
if (out !== null) process.stdout.write(out);
`;

test('model_used persistido = slug RESOLVIDO do provider (deepseek direto nunca o cru)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const scriptPath = path.join(process.env.NC_HOME, 'wire-classify-model-used.mjs');
  writeFileSync(scriptPath, WIRE_CHILD_SOURCE, 'utf8');
  const child = spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', scriptPath, root],
    { encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(child.status, 0, `filho do wire test falhou: ${child.stderr || child.stdout || child.error}`);
  assert.ok(child.stdout.trim(), 'filho sem stdout');
  const out = JSON.parse(child.stdout);
  // openrouter: translateModel é IDENTIDADE — o valor de hoje (slug OpenRouter) é preservado.
  assert.equal(out.openrouter, 'deepseek/deepseek-v4-flash-0731', 'openrouter: identidade');
  // deepseek: o provider ativo resolve p/ o id direto — model_used segue o ledger/transporte.
  assert.equal(out.deepseek, 'deepseek-v4-flash', 'deepseek: slug direto, não o cru do models.json');
});

// Espelha config/taxonomy.json: obrigatórias = domain, content-type, topic-technology.
const FACETS = [
  { name: 'domain', mandatory: true },
  { name: 'content-type', mandatory: true },
  { name: 'topic-technology', mandatory: true },
  { name: 'difficulty', mandatory: false },
  { name: 'ecosystem-language', mandatory: false },
  { name: 'concept-theme', mandatory: false },
];
// ok=false só para as facetas nomeadas em `down`; o resto responde (ok:true).
const results = (down = []) =>
  FACETS.map((f) => ({ facet: f.name, ok: !down.includes(f.name) }));

test('queda TOTAL de rede (todas as facetas ok:false) => incompleto — cenário das 185 vítimas', () => {
  const failed = failedMandatoryFacets(FACETS.map((f) => ({ facet: f.name, ok: false })), FACETS);
  assert.deepEqual(new Set(failed), new Set(['domain', 'content-type', 'topic-technology']));
});

test('uma faceta obrigatória (domain) caiu, resto ok => incompleto (mantém pendente)', () => {
  assert.deepEqual(failedMandatoryFacets(results(['domain']), FACETS), ['domain']);
});

test('só facetas NÃO-obrigatórias caíram => NÃO é incompleto (persiste como parcial)', () => {
  assert.deepEqual(failedMandatoryFacets(results(['difficulty', 'concept-theme']), FACETS), []);
});

test('faceta obrigatória VAZIA de verdade (ok:true) => NÃO é incompleto (não re-classifica p/ sempre)', () => {
  // o LLM respondeu, só não achou tag — resultado real de baixa qualidade; deve persistir uma vez.
  assert.deepEqual(failedMandatoryFacets(results([]), FACETS), []);
});

test('lista de resultados vazia (defensivo) => nenhuma obrigatória falhou', () => {
  assert.deepEqual(failedMandatoryFacets([], FACETS), []);
});
