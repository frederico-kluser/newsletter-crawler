// Partes PURAS da curadoria: chunking sem cortar item e consolidação (normalização de URL,
// descarte de interno/sponsor/job com backstop determinístico, dedup, data da issue).
// Também cobre o parâmetro AUTORITATIVO issueDate do curateRoundup (P1 da captura
// 2026-08-14: a data da issue vinha da listagem mas era descartada) via um filho com o
// LLM mockado (mesmo padrão de classify.incomplete.test.js — sem rede, sem SDK).
// NC_HOME temporário ANTES do import (curate.js importa db.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-curate-'));
const { chunkMarkdown, consolidateItems, isRealRecoveredItem, splitIntoSections, sectionTitleOf } =
  await import('../src/curate.js');
const { db } = await import('../src/db.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

const BASE = 'https://weekly.test/issues/10';

test('chunkMarkdown: 1 chunk quando cabe; quebra em linha vazia sem cortar item', () => {
  assert.deepEqual(chunkMarkdown('abc', 100), ['abc']);
  assert.deepEqual(chunkMarkdown('', 100), []);
  const md = ['item um linha', 'item dois linha', 'item tres linha'].join('\n\n');
  const chunks = chunkMarkdown(md, 20);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((c) => c.startsWith('item')));
});

test('sectionTitleOf: heading, negrito e rótulo com emoji; ignora linha comum', () => {
  assert.equal(sectionTitleOf('## Code & Tools'), 'Code & Tools');
  assert.equal(sectionTitleOf('**IN BRIEF:**'), 'IN BRIEF');
  assert.equal(sectionTitleOf('🛠 Code & Tools'), 'Code & Tools');
  assert.equal(sectionTitleOf('Releases'), 'Releases');
  assert.equal(sectionTitleOf('Um parágrafo qualquer com https://ex.com no meio'), null);
  assert.equal(sectionTitleOf('Fastify 5.9 melhora o request.mediaType e corrige bugs'), null);
});

test('sectionTitleOf: NUNCA promove item/prosa a seção (link em heading, frase com [.!?])', () => {
  assert.equal(sectionTitleOf('## [Deno 2.9](https://deno.com)'), null, 'heading de ITEM com link');
  assert.equal(sectionTitleOf('[Tools](https://ex.com/tools)'), null, 'link puro com palavra de seção');
  assert.equal(sectionTitleOf('More news next week.'), null, 'frase de prosa');
  assert.equal(sectionTitleOf('Try these tools today!'), null, 'frase de prosa com "tools"');
  assert.equal(sectionTitleOf('In other news'), 'In other news', 'rótulo real sem pontuação segue valendo');
});

test('splitIntoSections: 1 fatia por seção + intro; sem seções cai p/ chunk', () => {
  const md = [
    'Destaque do topo com bastante texto para virar a fatia intro da edição sem heading.',
    '',
    '**IN BRIEF:**',
    'npm agora trava contas de alto impacto por 72h ao trocar email.',
    'Deno mostra um gerador de apps desktop novo.',
    '',
    '🛠 Code & Tools',
    'Node-GTK 4.0 — bindings GTK para Node com suporte a Node 26.',
    'Vercel AI SDK 7 — biblioteca provider-agnostic para apps de IA.',
  ].join('\n');
  const secs = splitIntoSections(md);
  assert.deepEqual(secs.map((s) => s.section), [null, 'IN BRIEF', 'Code & Tools']);
  assert.ok(secs[0].text.startsWith('Destaque do topo'));

  // texto sem seção detectável -> fatia única (section null)
  const plain = splitIntoSections('Só um blob sem títulos, curtinho.');
  assert.equal(plain.length, 1);
  assert.equal(plain[0].section, null);
});

test('isRealRecoveredItem: âncora genérica/sem blurb é secundário; item com blurb real entra', () => {
  assert.equal(isRealRecoveredItem({ title: 'Demo.', blurb: null }), false);
  assert.equal(isRealRecoveredItem({ title: 'Release notes', blurb: 'x'.repeat(50) }), false);
  assert.equal(isRealRecoveredItem({ title: 'GTK', blurb: 'toolkit citado de passagem' }), false, 'título curto demais');
  assert.equal(isRealRecoveredItem({ title: 'Wasp framework', blurb: 'curto' }), false, 'blurb raso');
  assert.equal(
    isRealRecoveredItem({
      title: '37 Node CLI App Best Practices',
      blurb: 'A long-standing, but now modernized, set of guidelines for building CLI tools.',
    }),
    true,
  );
});

test('consolidateItems: normaliza, deduplica, descarta interno e força sponsor/job', () => {
  const results = [
    {
      issue_date: '2026-07-02',
      items: [
        { url: 'https://ex.org/post?utm_source=nl', title: 'Post A', kind: 'news', section: null, blurb: 'blurb a' },
        { url: 'https://ex.org/post', title: 'Post A duplicado', kind: 'news', section: null, blurb: null },
        { url: 'https://weekly.test/issues/9', title: 'Edição anterior', kind: 'news', section: null, blurb: null },
        { url: 'https://tool.dev/x', title: 'Ferramenta X', kind: 'tool', section: 'Code & Tools', blurb: 'faz x' },
        { url: 'https://ads.example/promo', title: 'Fleet de agentes', kind: 'news', section: null, blurb: 'Planeje e envie PRs. AgentField.ai sponsor' },
        { url: 'https://jobs.example/sre', title: 'Vaga SRE', kind: 'news', section: '📰 Classifieds — hiring', blurb: null },
        { url: 'mailto:oi@x.com', title: 'contato', kind: 'news', section: null, blurb: null },
      ],
    },
    { issue_date: null, items: [{ url: 'https://rel.dev/v2', title: 'Lib 2.0', kind: 'release', section: 'Releases', blurb: 'changelog' }] },
  ];
  const { items, skipped, issueDateRaw } = consolidateItems(results, { baseUrl: BASE });
  assert.equal(issueDateRaw, '2026-07-02');
  const urls = items.map((i) => i.url).sort();
  assert.deepEqual(urls, ['https://ex.org/post', 'https://rel.dev/v2', 'https://tool.dev/x']);
  assert.equal(items.find((i) => i.url === 'https://tool.dev/x').kind, 'tool');
  assert.equal(items.find((i) => i.url === 'https://rel.dev/v2').kind, 'release');
  assert.equal(skipped.sponsor, 1, 'backstop: blurb com "sponsor" vira sponsor mesmo rotulado news');
  assert.equal(skipped.job, 1, 'backstop: section de classificados vira job');
  assert.equal(skipped.internal, 1);
  assert.equal(skipped.invalid, 1);
});

// ---- curateRoundup com issueDate AUTORITATIVO (da listagem) ----
// O insert usa `issueDate` (cadastrado com published_at: issueDate); o parâmetro novo vence o
// issue_date que o modelo viu na página E o texto/meta da página. Wire em filho com o
// transporte do SDK fake (padrão do llm.provider-client.test.js): o llm.js REAL (callJSON +
// zod) roda por cima, sem rede.
const CURATE_WIRE_CHILD_SOURCE = `import { mock } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import OpenAI from 'openai';

const root = process.argv[2]; // raiz da worktree (passada pelo teste pai)
const ncHome = mkdtempSync(path.join(tmpdir(), 'nc-curate-wire-'));
process.env.NC_HOME = ncHome;
process.on('exit', () => rmSync(ncHome, { recursive: true, force: true }));
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) delete process.env[k];
}
process.env.OPENROUTER_API_KEY = 'sk-or-teste'; // HAS_LLM on p/ a curadoria rodar

const Completions = OpenAI.Chat.Completions;
mock.method(Completions.prototype, 'create', async function createMock(body) {
  const name = body?.response_format?.json_schema?.name;
  if (name === 'curated_items') {
    return {
      model: 'deepseek-v4-flash', usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [{ message: { content: JSON.stringify(itemFor(curSuffix)) } }],
    };
  }
  throw new Error('schema inesperado no wire test: ' + name);
});

// Página da issue SEM meta/time/JSON-LD e SEM data no texto: a data da página é null — tudo o
// que o insert gravar veio da cadeia issueDate(autoritativo) -> issue_date(LLM) -> página.
const FIXTURE = \`<html><head><title>Cur Weekly #10</title></head><body>
<article>
<h1>Cur Weekly #10</h1>
<p>This is a fake newsletter issue body with enough prose to pass the curatable threshold and exercise the pipeline without any network call at all.</p>
<p>Second paragraph keeps the body comfortably above the 200-char minimum so extraction succeeds deterministically.</p>
</article></body></html>\`;

let curSuffix = 'a';
const itemFor = (suffix) => ({
  // issue_date que o MODELO viu na página — deve PERDER para o issueDate autoritativo.
  issue_date: '2026-08-05',
  items: [{
    url: 'https://ex.org/cur-' + suffix, title: 'Post ' + suffix,
    kind: 'news', section: null, blurb: 'blurb do agregador ' + suffix,
  }],
});
// Logs da curadoria vão p/ o console (stdout) — silencia p/ o stdout carregar SÓ o JSON final.
const { setLogSink } = await import(pathToFileURL(path.join(root, 'src/util.js')).href);
setLogSink(() => {});
const { stmts, db } = await import(pathToFileURL(path.join(root, 'src/db.js')).href);
const { curateRoundup } = await import(pathToFileURL(path.join(root, 'src/curate.js')).href);

const src = stmts.upsertSource.get({
  name: 'CurWeekly', base_url: 'https://cur.test', type: 'index', max_index_pages: null,
});
const publishedByIssue = (url) =>
  stmts.listArticlesBySource.all(src.id).filter((r) => r.issue_url === url).map((r) => r.published_at);

const out = {};
try {
  // (a) autoritativo vence o issue_date do LLM e a página.
  {
    const url = 'https://cur.test/issues/10-a';
    curSuffix = 'a';
    const summary = await curateRoundup({
      html: FIXTURE, url, source: src, runId: 1, depth: 1, sinceDate: null, issueDate: '2026-08-13',
    });
    out.a = { published: publishedByIssue(url), issueDate: summary.issueDate };
  }
  // (b) data FUTURA do par da listagem: clampFutureDate crava hoje (âncora vale p/ a issue toda).
  {
    const url = 'https://cur.test/issues/10-b';
    curSuffix = 'b';
    await curateRoundup({
      html: FIXTURE, url, source: src, runId: 1, depth: 1, sinceDate: null, issueDate: '2027-06-01',
    });
    out.b = publishedByIssue(url);
    out.today = new Date().toISOString().slice(0, 10);
  }
  // (c) SEM autoritativo: o issue_date do modelo segue valendo (cadeia preservada).
  {
    const url = 'https://cur.test/issues/10-c';
    curSuffix = 'c';
    await curateRoundup({ html: FIXTURE, url, source: src, runId: 1, depth: 1, sinceDate: null, issueDate: null });
    out.c = publishedByIssue(url);
  }
  // (d) issue autoritativamente ANTERIOR ao piso -> belowFloor, nada inserido.
  {
    const url = 'https://cur.test/issues/10-d';
    curSuffix = 'd';
    const summary = await curateRoundup({
      html: FIXTURE, url, source: src, runId: 1, depth: 1,
      sinceDate: new Date('2026-08-11'), issueDate: '2026-07-01',
    });
    out.d = { belowFloor: Boolean(summary?.belowFloor), count: publishedByIssue(url).length };
  }
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  process.stderr.write(String((e && e.stack) || e));
  process.exitCode = 1;
} finally {
  db.close();
}
`;

test('curateRoundup: issueDate autoritativo (da listagem) vence a página; futura é clampada; piso respeitado', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // Script num tmp com symlink p/ o node_modules da worktree: o `import 'openai'` do filho
  // resolve para a MESMA instância de módulo que o llm.js usa (a identidade do prototype mock).
  const wireDir = mkdtempSync(path.join(os.tmpdir(), 'nc-curate-wire-dir-'));
  try {
    symlinkSync(path.join(root, 'node_modules'), path.join(wireDir, 'node_modules'), 'dir');
    const scriptPath = path.join(wireDir, 'wire-curate-issue-date.mjs');
    writeFileSync(scriptPath, CURATE_WIRE_CHILD_SOURCE, 'utf8');
    const child = spawnSync(
      process.execPath,
      [scriptPath, root],
      { encoding: 'utf8', timeout: 60000 },
    );
    assert.equal(child.status, 0, `filho do wire test falhou: ${child.stderr || child.stdout || child.error}`);
    assert.ok(child.stdout.trim(), 'filho sem stdout');
    const out = JSON.parse(child.stdout);
    assert.deepEqual(out.a.published, ['2026-08-13'], 'insert usa o issueDate AUTORITATIVO (vence o 08-05 do LLM)');
    assert.equal(out.a.issueDate, '2026-08-13');
    assert.deepEqual(out.b, [out.today], 'data futura da listagem é clampada p/ hoje');
    assert.deepEqual(out.c, ['2026-08-05'], 'sem autoritativo: o issue_date do modelo segue valendo');
    assert.equal(out.d.belowFloor, true, 'issue anterior ao piso --since é ignorada');
    assert.equal(out.d.count, 0);
  } finally {
    rmSync(wireDir, { recursive: true, force: true });
  }
});
