// Regressão do P4 (captura Node Weekly 2026-08-14): o corpo do artigo da Drizzle começava com
// o menu de navegação do site ("Website • / Docs • / Community • / Blog • / Changelog") e a
// verificação deu "ok" — falso-positivo. Fix: (1) heurística determinística pré-LLM
// (startsWithNavMenu) marca suspect SEM chamada LLM; (2) o prompt do verifyRecordLLM ganhou o
// caso real como exemplo. NC_HOME temporário ANTES do import (verify.js -> db.js abre o banco
// no load); SDK mockado p/ CONTAR as chamadas LLM (a heurística precisa pular o LLM inteiro).
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import OpenAI from 'openai'; // mesma instância de módulo que src/llm.js usa
import { setLogSink } from '../src/util.js';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-verify-nav-'));
process.env.NC_HOME = NC_HOME_TMP;
for (const k of Object.keys(process.env)) {
  // Env limpo: nada do shell/usuário pode vazar p/ a resolução (mesmo padrão dos outros testes).
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) {
    delete process.env[k];
  }
}
process.env.LLM_PROVIDER = 'deepseek';
process.env.DEEPSEEK_API_KEY = 'sk-ds-a';
process.on('exit', () => rmSync(NC_HOME_TMP, { recursive: true, force: true }));

const verify = await import('../src/verify.js');
const llm = await import('../src/llm.js');

// ---- mock do SDK: intercepta `chat.completions.create` e CONTA as chamadas LLM ----
const Completions = OpenAI.Chat.Completions;
const calls = [];
let createImpl = async () => ({
  model: 'deepseek-v4-flash',
  usage: { prompt_tokens: 1, completion_tokens: 1 },
  choices: [{ message: { content: JSON.stringify({ verdict: 'ok', problems: [] }) } }],
});
mock.method(Completions.prototype, 'create', async function createMock(body, options) {
  calls.push({ body, options, client: this._client });
  return createImpl();
});

const DRIZZLE_CONTENT =
  'Website • / Docs • / Community • / Blog • / Changelog\n\n' +
  'Full-text search in Drizzle: FTS5-based full-text search with the drizzle-paradedb extension…';

after(() => {
  mock.restoreAll();
  setLogSink(null);
});

// ---- heurística pura: startsWithNavMenu ----

test('startsWithNavMenu: caso real da Drizzle (bullet+slash) -> true', () => {
  assert.equal(verify.startsWithNavMenu(DRIZZLE_CONTENT), true);
});

test('startsWithNavMenu: menu com bullets simples / pipes / slashes / bullet inicial -> true', () => {
  assert.equal(verify.startsWithNavMenu('Website • Docs • Community • Blog • Changelog'), true);
  assert.equal(verify.startsWithNavMenu('Home | Blog | About | Contact'), true);
  assert.equal(verify.startsWithNavMenu('Docs / API / Blog / GitHub'), true);
  assert.equal(verify.startsWithNavMenu('• Home • Docs • Blog • Contact'), true);
});

test('startsWithNavMenu: corpo limpo não dispara (prosa real, 1-2 separadores, URL, menu tardio)', () => {
  assert.equal(
    verify.startsWithNavMenu(
      'Imagine you are building an e-commerce platform. This is a long article body with normal prose.',
    ),
    false,
  );
  assert.equal(verify.startsWithNavMenu('You can read / watch / listen to this episode now.'), false, 'só 2 separadores');
  assert.equal(verify.startsWithNavMenu('https://github.com/hucre/hucre/blob/main/README.md\n\nReal content.'), false, 'URL não é menu');
  assert.equal(verify.startsWithNavMenu('x'.repeat(130) + ' Website • Docs • Community • Blog • Changelog'), false, 'menu fora dos 120 chars iniciais');
});

// ---- integração: verifyArticleRow pula o LLM quando a heurística dispara ----

test('verifyArticleRow: corpo abrindo com nav-menu -> suspect determinístico SEM chamada LLM', async () => {
  calls.length = 0;
  const out = await verify.verifyArticleRow({
    id: 1, url: 'https://example.com/drizzle', title: 'Full-Text Search in Drizzle', kind: 'tool',
    blurb: 'b', content: DRIZZLE_CONTENT,
  });
  assert.deepEqual(out, { verdict: 'suspect', problems: ['conteúdo começa com menu de navegação'] });
  assert.equal(calls.length, 0, 'heurística pré-LLM: NENHUMA chamada ao LLM');
});

test('verifyArticleRow: corpo limpo -> LLM roda (1 chamada) e o veredito do modelo vale', async () => {
  calls.length = 0;
  createImpl = async () => ({
    model: 'deepseek-v4-flash',
    usage: { prompt_tokens: 1, completion_tokens: 1 },
    choices: [{ message: { content: JSON.stringify({ verdict: 'ok', problems: [] }) } }],
  });
  const out = await verify.verifyArticleRow({
    id: 2, url: 'https://example.com/clean', title: 'A real article', kind: 'news',
    blurb: 'b', content: 'Full text of a real article about databases and search indexes, nothing else here.',
  });
  assert.deepEqual(out, { verdict: 'ok', problems: [] });
  assert.equal(calls.length, 1, 'corpo limpo: LLM roda normalmente');
});

// ---- prompt: o exemplo do nav-menu está no verifyRecordLLM (P4, metade LLM) ----

test('verifyRecordLLM: prompt traz o caso real do menu no início (exemplo explícito)', async () => {
  calls.length = 0;
  createImpl = async () => ({
    model: 'deepseek-v4-flash',
    usage: { prompt_tokens: 1, completion_tokens: 1 },
    choices: [{ message: { content: JSON.stringify({ verdict: 'ok', problems: [] }) } }],
  });
  await llm.verifyRecordLLM({ url: 'https://x.com/1', kind: 'news', title: 'T', blurb: 'b', content: 'c' });
  const userText = calls[0].body.messages.find((m) => m.role === 'user').content;
  assert.match(userText, /Website • Docs • Community • Blog • Changelog/, 'exemplo do caso real no prompt');
  assert.match(userText, /menu de navegação/, 'a regra "menu no topo = suspect" está no prompt');
});
