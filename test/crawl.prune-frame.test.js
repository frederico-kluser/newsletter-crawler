// P6b na trilha REAL do crawl (P5/P6 da captura 2026-08-14): quando a limpeza IA falha, o
// conteúdo salvo passa pela poda determinística de moldura (prunePageFrame) — a byline/rodapé
// do meiert.com NÃO entram na ficha. Wire test no padrão do crawl.issue-date.test.js: filho
// com mock de módulo (fetchSmart fake + transporte LLM fake que FALHA no clean) e
// processArticle REAL. ZERO rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const WIRE_CHILD_SOURCE = `import { mock } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import OpenAI from 'openai';

const root = process.argv[2]; // raiz da worktree (passada pelo teste pai)
const ncHome = mkdtempSync(path.join(tmpdir(), 'nc-prune-frame-'));
process.env.NC_HOME = ncHome;
process.on('exit', () => rmSync(ncHome, { recursive: true, force: true }));
// Env limpo: nada do shell pode vazar p/ a resolução de modelos.
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) delete process.env[k];
}
process.env.OPENROUTER_API_KEY = 'sk-or-teste'; // HAS_LLM on p/ o clean rodar (e FALHAR)

// Transporte FAKE: o LLM está "fora do ar" — toda chamada falha (o clean cai no catch).
const Completions = OpenAI.Chat.Completions;
mock.method(Completions.prototype, 'create', async function createMock() {
  throw new Error('mock: LLM fora do ar (clean deve falhar)');
});

// fetchSmart FAKE: devolve a página REAL do meiert.com (a moldura está no HTML-fonte).
mock.module(pathToFileURL(path.join(root, 'src/fetch.js')).href, {
  namedExports: {
    fetchSmart: async (url) => ({ html: readFileSync(path.join(root, 'test/fixtures/meiert-5-npx-helpers.html'), 'utf8'), url }),
    checkRobots: async () => ({ allowed: true }),
  },
});

// Logs do crawler vão p/ o console — silencia p/ o stdout carregar SÓ o JSON final.
const { setLogSink } = await import(pathToFileURL(path.join(root, 'src/util.js')).href);
setLogSink(() => {});
const { stmts, db } = await import(pathToFileURL(path.join(root, 'src/db.js')).href);
const { enqueue, processJob } = await import(pathToFileURL(path.join(root, 'src/crawl.js')).href);

const out = {};
try {
  const src = stmts.upsertSource.get({
    name: 'MeiertWire', base_url: 'https://meiert.com', type: 'listing', max_index_pages: null,
  });
  const url = 'https://meiert.com/blog/5-npx-helpers';
  enqueue(url, 'article', null, src.id, 1);
  await processJob(stmts.claimNext.get(), { runId: 1, sinceDate: null, aggressive: true });
  const row = stmts.getArticleFullByUrl.get(url);
  out.saved = Boolean(row);
  out.start = row?.content.slice(0, 80) ?? null;
  out.end = row?.content.slice(-90) ?? null;
  out.len = row?.content.length ?? 0;
  out.cleaned = row?.cleaned ?? null;
} catch (e) {
  process.stderr.write(String((e && e.stack) || e));
  process.exitCode = 1;
} finally {
  db.close();
}
process.stdout.write(JSON.stringify(out));
`;

test('wire: clean IA falha -> prunePageFrame remove byline/rodapé antes de salvar', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // Script num tmp com symlink p/ o node_modules da worktree (mesma identidade de módulo).
  const wireDir = mkdtempSync(path.join(os.tmpdir(), 'nc-prune-frame-dir-'));
  try {
    symlinkSync(path.join(root, 'node_modules'), path.join(wireDir, 'node_modules'), 'dir');
    const scriptPath = path.join(wireDir, 'wire-prune-frame.mjs');
    writeFileSync(scriptPath, WIRE_CHILD_SOURCE, 'utf8');
    const child = spawnSync(
      process.execPath,
      ['--experimental-test-module-mocks', scriptPath, root],
      { encoding: 'utf8', timeout: 60000 },
    );
    assert.equal(child.status, 0, `filho do wire test falhou: ${child.stderr || child.stdout || child.error}`);
    assert.ok(child.stdout.trim(), 'filho sem stdout');
    const out = JSON.parse(child.stdout);
    assert.equal(out.saved, true, 'artigo salvo mesmo com o clean falho (fail-open)');
    assert.ok(out.start.startsWith('npx allows you to run Node.js packages right away.'), `byline removida: ${out.start}`);
    assert.ok(!out.end.includes('Here on meiert.com'), `rodapé/bio removido: ${out.end}`);
    assert.equal(out.cleaned, 0, 'cleaned=0 (o clean IA não chegou a aplicar)');
  } finally {
    rmSync(wireDir, { recursive: true, force: true });
  }
});
