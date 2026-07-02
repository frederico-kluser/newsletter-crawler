// Partes PURAS da curadoria: chunking sem cortar item e consolidação (normalização de URL,
// descarte de interno/sponsor/job com backstop determinístico, dedup, data da issue).
// NC_HOME temporário ANTES do import (curate.js importa db.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
