// Fix P4 (captura 2026-08-14 — "README em vez de release notes": BullMQ 6.1, smol-toml 1.8,
// swift-node 0.1.2) + guarda JSON (react-dropzone 20.0) no caminho do `ncrawl reextract`.
// Investigação com página REAL (github.com/taskforcesh/bullmq): os boletins linkaram a RAIZ
// do repo (github.com/owner/repo), que serve o README — a página NÃO contém release notes
// (sinal determinístico = URL sem /releases). As notas reais ficam na LISTAGEM /releases
// (1ª release = a mais recente, server-rendered; fixture REAL trimada github-bullmq-releases.html).
// PostgREST 16.0 ("truncada no final") NÃO é truncamento: as notas terminam de verdade em
// "RFC 9535." (só o Box-footer vem depois) — o suspect do verify era falso-positivo.
// Sem chave LLM: caminho determinístico (re-extração + 2º passe + guardas; sem clean/verify IA).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// NC_HOME temporário ANTES do import (config.js -> db.js). Chave LLM FORA do ambiente p/ o
// caminho ser 100% determinístico. Mesmo padrão de test/commands.reextract.test.js.
process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-reextract-gh-'));
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) delete process.env[k];
}
const { writeFileSync } = await import('node:fs');
writeFileSync(
  path.join(process.env.NC_HOME, '.env'),
  'OPENROUTER_API_KEY=\nDEEPSEEK_API_KEY=\nLLM_PROVIDER=\n',
);
const { reextractTargets, looksLikeJson } = await import('../src/reextract.js');
const { isGithubRepoRoot, githubLatestReleaseText, looksLikeReleaseNotes } = await import('../src/parse-core.js');
const { stmts, db } = await import('../src/db.js');
// O buffer de eventos só grava em lote (EVENTS_FLUSH_AT=50) — os testes consultam a tabela,
// então drenam o buffer explicitamente antes de ler.
const { flushEvents } = await import('../src/events.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readFixture = (name) => readFileSync(path.join(ROOT, 'test/fixtures', name), 'utf8');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

const insertRow = (row) =>
  stmts.insertArticle.run({
    source_id: null,
    url: row.url,
    title: row.title,
    content: row.content ?? 'conteúdo antigo e poluído',
    content_hash: row.content_hash ?? `hash-${row.url}`,
    published_at: row.published_at ?? null,
    run_id: 1,
    kind: 'kind' in row ? row.kind : 'release',
    issue_url: row.issue_url ?? null,
    section: null,
    blurb: row.blurb ?? 'blurb do agregador',
    content_source: row.content_source ?? 'target',
    cleaned: 0,
    needs_enrich: 0,
  });

const BULLMQ_ROOT = 'https://github.com/taskforcesh/bullmq';
const BULLMQ_RELEASES = 'https://github.com/taskforcesh/bullmq/releases';
const RELEASES_FIXTURE = readFixture('github-bullmq-releases.html');

// README da raiz PARAMETRIZADO por slug: o conteúdo entra no UNIQUE(content_hash) — dois
// testes com o MESMO texto colidiriam em dup-hash (INSERT OR IGNORE + getArticleByHash).
const readmePage = (slug) => `<!DOCTYPE html><html lang="en"><head>
<title>GitHub - ${slug}/repo: a queue for Node.js</title></head><body><main><article>
<h1>${slug}</h1>
<p>The fastest, most reliable, Redis-based distributed queue for Node.js and more, carefully written for rock solid stability and atomicity. This is the ${slug} instance of the same readme template so the extracted text stays unique per test run.</p>
<h2>Documentation</h2>
<p>You can find tutorials and news in this blog: https://blog.taskforce.sh/. The documentation covers the full API surface, including producers, workers, queues, schedules, and the proxying layer that lets other languages share the same Redis infrastructure.</p>
<h2>Contributing</h2>
<p>Contributions are welcome, see the contributing doc that has more details. Thanks for all the contributors that made this library possible, also a special mention to the maintainers that kindly donated their time and energy over the years to keep the project healthy and the community growing steadily.</p>
</article></main></body></html>`;

// ---- testes de unidade dos sinais determinísticos ----

test('p4: isGithubRepoRoot distingue raiz do repo de página de release (determinístico)', () => {
  assert.equal(isGithubRepoRoot('https://github.com/taskforcesh/bullmq'), true, 'raiz do repo');
  assert.equal(isGithubRepoRoot('https://github.com/taskforcesh/bullmq/'), true, 'raiz com barra final');
  assert.equal(isGithubRepoRoot('https://www.github.com/taskforcesh/bullmq'), true, 'www');
  assert.equal(isGithubRepoRoot('https://github.com/taskforcesh/bullmq/releases'), false, 'listagem de releases');
  assert.equal(isGithubRepoRoot('https://github.com/PostgREST/postgrest/releases/tag/v16.0'), false, 'release específica');
  assert.equal(isGithubRepoRoot('https://github.com/taskforcesh/bullmq/tree/main'), false, 'subpágina');
  assert.equal(isGithubRepoRoot('https://example.com/taskforcesh/bullmq'), false, 'host externo');
  assert.equal(isGithubRepoRoot('não é url'), false, 'url inválida');
});

test('p4: githubLatestReleaseText pega a 1ª (mais recente) release da listagem real', () => {
  const notes = githubLatestReleaseText(RELEASES_FIXTURE);
  assert.ok(notes, 'notas extraídas da fixture real');
  assert.ok(notes.startsWith('6.1.1 (2026-08-14)'), '1ª release (a mais recente) — não a 2ª');
  assert.ok(!notes.includes('1.2.4 (2026-08-13)'), 'release antiga fica de fora');
  assert.ok(looksLikeReleaseNotes(notes), 'aceita pela regra de marcadores');
  assert.equal(looksLikeReleaseNotes('A nice README paragraph about the project without any pull request references at all.'), false, 'README não passa como release note');
  assert.equal(githubLatestReleaseText('<html><body><p>sem main nem markdown-body</p></body></html>'), null, 'página sem container');
});

test('p4: looksLikeJson detecta JSON cru (real react-dropzone) e ignora prosa', () => {
  const jsonFixture = readFixture('json-page.html');
  const jsonBody = jsonFixture.match(/<pre>([\s\S]*)<\/pre>/)[1].trim();
  assert.equal(looksLikeJson(jsonBody), true, 'JSON completo (parseável)');
  assert.equal(looksLikeJson(`{"title": "cortado no meio", "body": "aqui o JSON truncado"`), true, 'JSON truncado (par chave:valor)');
  assert.equal(looksLikeJson('The fastest, most reliable queue for Node.js. '.repeat(10)), false, 'prosa');
  assert.equal(looksLikeJson('{"a":1}'), false, 'curto demais');
  assert.equal(looksLikeJson(''), false, 'vazio');
});

// ---- testes de fluxo (reextract) com fetch mockado ----

test('p4: release com URL da RAIZ do repo recupera as notas via /releases (em vez do README)', async () => {
  insertRow({ url: BULLMQ_ROOT, title: 'BullMQ 6.1', kind: 'release' });
  let releasesFetched = 0;
  const fakeFetch = async (url) => {
    if (url === BULLMQ_RELEASES) { releasesFetched++; return { html: RELEASES_FIXTURE, url }; }
    if (url === BULLMQ_ROOT) return { html: readmePage("bullmq"), url };
    return { html: '<html><body><p>nenhum corpo real aqui.</p></body></html>', url };
  };

  const out = await reextractTargets({ fetchSmartImpl: fakeFetch, urlFilter: 'taskforcesh' });
  assert.equal(out.reextracted, 1, 'ficha re-extraída com as notas');
  assert.equal(out.skipped, 0);
  assert.equal(releasesFetched, 1, 'um re-fetch da listagem /releases');

  const row = stmts.getArticleFullByUrl.get(BULLMQ_ROOT);
  assert.ok(row.content.startsWith('6.1.1 (2026-08-14)'), 'conteúdo = release notes, não o README');
  assert.ok(row.content.includes('Bug Fixes'), 'notas completas (1ª release)');
  assert.ok(!row.content.includes('The fastest, most reliable'), 'README não entrou');
  assert.notEqual(row.content_hash, 'hash-' + BULLMQ_ROOT, 'hash re-calculado');
  assert.equal(row.content_source, 'target');
  assert.equal(row.verify_status, null, 'sem LLM: verify não roda');
});

test('p4: release com URL da RAIZ mas kind != release NÃO busca /releases (README re-extraído)', async () => {
  // URL própria do teste (INSERT OR IGNORE: URL duplicada entre testes não criaria a ficha).
  const url = 'https://github.com/squirrelchat/smol-toml';
  insertRow({ url, title: 'smol-toml news', kind: null });
  let releasesFetched = 0;
  const fakeFetch = async (u) => {
    if (u === 'https://github.com/squirrelchat/smol-toml/releases') { releasesFetched++; return { html: RELEASES_FIXTURE, url: u }; }
    return { html: readmePage("gh-" + new URL(u).pathname.split("/").filter(Boolean)[0] || "x"), url: u };
  };

  const out = await reextractTargets({ fetchSmartImpl: fakeFetch, urlFilter: 'smol-toml' });
  assert.equal(out.reextracted, 1);
  assert.equal(releasesFetched, 0, 'sem kind release, sem recovery — a URL raiz é o conteúdo legítimo');
  const row = stmts.getArticleFullByUrl.get(url);
  assert.ok(row.content.includes('The fastest, most reliable'), 'README re-extraído normalmente');
  assert.notEqual(row.content_hash, 'hash-' + url, 're-extração normal persistiu');
});

test('p4: falha no fetch de /releases mantém a ficha atual (fail-open github-repo-root-readme)', async () => {
  const url = 'https://github.com/biw/swift-node';
  insertRow({ url, title: 'swift-node 0.1.2', kind: 'release' });
  const fakeFetch = async (u) => {
    if (u === 'https://github.com/biw/swift-node/releases') throw new Error('rede fora');
    return { html: readmePage("gh-" + new URL(u).pathname.split("/").filter(Boolean)[0] || "x"), url: u };
  };

  const out = await reextractTargets({ fetchSmartImpl: fakeFetch, urlFilter: 'swift-node' });
  assert.equal(out.reextracted, 0);
  assert.equal(out.skipped, 1, 'guard pulou a ficha');
  const row = stmts.getArticleFullByUrl.get(url);
  assert.equal(row.content, 'conteúdo antigo e poluído', 'ficha atual NÃO trocada');
  assert.equal(row.content_hash, 'hash-' + url, 'sem UPDATE');
  flushEvents();
  const ev = stmts.listEventsForUrl.all(`%${url}%`, 10).find((e) => e.stage === 'reextract');
  assert.ok(ev, 'evento de reextract registrado');
  assert.match(ev.detail, /"reason":"github-repo-root-readme"/, 'razão documentada no evento');
});

test('p4: /releases sem marcadores de release note NÃO substitui o README (fail-open)', async () => {
  // URL própria do teste (INSERT OR IGNORE — URL duplicada não criaria a ficha).
  const url = 'https://github.com/example/prose-repo';
  insertRow({ url, title: 'Prose Repo 1.0', kind: 'release' });
  const proseOnly = '<!DOCTYPE html><html><body><main><div class="markdown-body"><p>A friendly project overview written by the team to explain the goals and values of the library in plain words, with no pull request references and no changelog sections at all.</p></div></main></body></html>';
  const fakeFetch = async (u) => {
    if (u === 'https://github.com/example/prose-repo/releases') return { html: proseOnly, url: u };
    return { html: readmePage("gh-" + new URL(u).pathname.split("/").filter(Boolean)[0] || "x"), url: u };
  };

  const out = await reextractTargets({ fetchSmartImpl: fakeFetch, urlFilter: 'prose-repo' });
  assert.equal(out.reextracted, 0);
  assert.equal(out.skipped, 1);
  const row = stmts.getArticleFullByUrl.get(url);
  assert.equal(row.content, 'conteúdo antigo e poluído', 'README atual mantido');
});

test('p4: página que É JSON cru nunca é gravada (guarda json-page)', async () => {
  const url = 'https://react-dropzone.js.org';
  insertRow({ url, title: 'react-dropzone 20.0', kind: 'release' });
  const fakeFetch = async (u) => ({ html: readFixture('json-page.html'), url: u });

  const out = await reextractTargets({ fetchSmartImpl: fakeFetch, urlFilter: 'react-dropzone' });
  assert.equal(out.reextracted, 0, 'nada re-extraído');
  assert.equal(out.skipped, 1, 'guard pulou a ficha');
  const row = stmts.getArticleFullByUrl.get(url);
  assert.equal(row.content, 'conteúdo antigo e poluído', 'JSON NUNCA gravado');
  assert.equal(row.content_hash, 'hash-' + url, 'sem UPDATE');
  flushEvents();
  const ev = stmts.listEventsForUrl.all(`%${url}%`, 10).find((e) => e.stage === 'reextract');
  assert.ok(ev, 'evento de reextract registrado');
  assert.match(ev.detail, /"reason":"json-page"/, 'razão documentada no evento');
});

test('p4: release de PÁGINA específica (/releases/tag) segue o 2º passe clássico (sem recovery)', async () => {
  // O caso do vitest (botão "View changes on GitHub") já é coberto por commands.reextract.test.js;
  // aqui só confirmamos que um URL de release específica NÃO dispara o caminho repo-root.
  assert.equal(isGithubRepoRoot('https://github.com/vitest-dev/vitest/releases/tag/v5.0.0-rc.1'), false);
});
