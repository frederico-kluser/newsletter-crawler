// Achado 6 da captura-total-2026-08-14 (§9.6): itens diretos de fontes listing (AI Weekly,
// llmnews.ai — 65/188) entram com kind NULL, porque a curadoria de roundup (única origem do
// kind até aqui) não os toca. O fix deriva o kind DETERMINISTICAMENTE das classifications que
// já existem — sem LLM: kindFromTags (release ← content-type, tool ← isToolByTags, senão news)
// aplicado na persistência de CADA classificação SÓ onde kind IS NULL (o WHERE protege o kind
// curado da curadoria, que nunca é sobrescrito).
// NC_HOME temporário ANTES do import (classify.js -> db.js abre o banco no load).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-kind-'));
const { kindFromTags } = await import('../src/classify.js');

after(() => rmSync(process.env.NC_HOME, { recursive: true, force: true }));

// ---- kindFromTags: derivação pura (sem LLM) a partir das linhas de article_tags ----

test('release ← content-type version-release/release-announcement', () => {
  assert.equal(kindFromTags([{ facet: 'content-type', tag: 'version-release' }]), 'release');
  assert.equal(kindFromTags([{ facet: 'content-type', tag: 'release-announcement' }]), 'release');
});

test('release vence sobre tool (lançamento + content-type de ferramenta no mesmo item)', () => {
  assert.equal(
    kindFromTags([
      { facet: 'content-type', tag: 'release-announcement' },
      { facet: 'content-type', tag: 'tool-release' },
    ]),
    'release',
  );
});

test('tool ← isToolByTags (content-type de ferramenta OU faceta framework-library-tool)', () => {
  assert.equal(kindFromTags([{ facet: 'content-type', tag: 'tool-release' }]), 'tool');
  assert.equal(kindFromTags([{ facet: 'content-type', tag: 'tooling' }]), 'tool');
  assert.equal(kindFromTags([{ facet: 'framework-library-tool', tag: 'react' }]), 'tool');
});

test('news ← default (sem sinal de release nem tool, lista vazia inclusive)', () => {
  assert.equal(kindFromTags([]), 'news');
  assert.equal(kindFromTags(null), 'news');
  assert.equal(kindFromTags([{ facet: 'content-type', tag: 'news' }]), 'news');
  assert.equal(kindFromTags([{ facet: 'domain', tag: 'reactjs' }]), 'news');
});

// ---- persistência: o kind derivado é gravado SÓ onde kind IS NULL ----
// O `persist` chama a API de verdade, então o filho roda com --experimental-test-module-mocks
// interceptando classifyFacet (a única chamada LLM) — teste determinístico, sem rede/SDK.
const WIRE_CHILD_SOURCE = `import { mock } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2]; // raiz da worktree (passada pelo teste pai)
const ncHome = mkdtempSync(path.join(tmpdir(), 'nc-kind-wire-'));
process.env.NC_HOME = ncHome;
process.on('exit', () => rmSync(ncHome, { recursive: true, force: true }));
// Env limpo: nada do shell pode vazar p/ a resolução de modelos (mesmo padrão do llm.provider).
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) delete process.env[k];
}
// Intercepta a ÚNICA chamada LLM da classificação (classifyFacet) — sem rede, sem SDK.
// As tags devolvidas são por faceta (mutável por cenário); as facetas não-core respondem
// vazias (status 'partial' ainda PERSISTE — contrato atual: persist roda p/ done e partial).
let facetTags = {};
mock.module(pathToFileURL(path.join(root, 'src/llm.js')).href, {
  namedExports: {
    classifyFacet: async ({ facet }) => ({
      tags: facetTags[facet] || [], uncovered: [], confidence: 0.9,
    }),
  },
});

const { stmts, db } = await import(pathToFileURL(path.join(root, 'src/db.js')).href);
const { classifyArticleRow } = await import(pathToFileURL(path.join(root, 'src/classify.js')).href);

const src = stmts.upsertSource.get({
  name: 'Kind', base_url: 'http://kind.test', type: 'listing', max_index_pages: null,
});

// Insere um artigo (com o kind de ENTRADA dado), classifica com as tags de content-type
// dadas e devolve o kind FINAL da coluna articles.kind.
async function classifyCase(relUrl, contentTypeTags, insertKind) {
  const url = 'http://kind.test/' + relUrl;
  const r = stmts.insertArticle.run({
    source_id: src.id, url, title: 'T ' + relUrl, content: 'corpo',
    content_hash: 'k-' + relUrl, published_at: null, run_id: null, kind: insertKind,
    issue_url: null, section: null, blurb: null, content_source: 'target', cleaned: 0, needs_enrich: 0,
  });
  const id = Number(r.lastInsertRowid);
  const [article] = stmts.listArticlesNeedingClassification.all(-1).filter((a) => a.id === id);
  facetTags = { 'content-type': contentTypeTags };
  await classifyArticleRow(article);
  return stmts.getArticleFullByUrl.get(url).kind;
}

let out = null;
try {
  out = JSON.stringify({
    release: await classifyCase('release', ['version-release'], null),
    tool: await classifyCase('tool', ['tool-release'], null),
    news: await classifyCase('news', ['news'], null),
    curatedKept: await classifyCase('curated', ['news'], 'release'),
  });
} catch (e) {
  process.stderr.write(String((e && e.stack) || e));
  process.exitCode = 1;
} finally {
  db.close();
}
if (out !== null) process.stdout.write(out);
`;

test('persist: kind preenchido só onde NULL — release/tool/news derivados, curado intocado', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const scriptPath = path.join(process.env.NC_HOME, 'wire-kind-persist.mjs');
  writeFileSync(scriptPath, WIRE_CHILD_SOURCE, 'utf8');
  const child = spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', scriptPath, root],
    { encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(child.status, 0, `filho do wire test falhou: ${child.stderr || child.stdout || child.error}`);
  assert.ok(child.stdout.trim(), 'filho sem stdout');
  assert.deepEqual(JSON.parse(child.stdout), {
    release: 'release',
    tool: 'tool',
    news: 'news',
    curatedKept: 'release', // kind curado de roundup: a classificação NUNCA sobrescreve
  });
});
