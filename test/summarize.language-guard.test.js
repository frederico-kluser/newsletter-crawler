// Guarda de idioma do stage summarize (Achado 1 da captura 2026-08-14: 11/188 títulos/resumos
// PT-BR em CHINÊS). Duas camadas: prompt reforçado (cláusula explícita de idioma no system) +
// validação DETERMINÍSTICA da saída (hasCjk/cjkRatio em util.js): CJK -> 1 re-try com reforço
// -> persistindo, THROW (a ficha fica NULL e é re-resumida no próximo run, sem persistir idioma
// errado) + evento `summarize/language-guard` p/ inspect/backfill.
// Mesmo harness dos testes de llm (mock do SDK openai no PROTÓTIPO, provider deepseek, ZERO
// rede). NC_HOME tmp/.env SEMEADO com as chaves do mock: o config.js o lê por ÚLTIMO
// (precedência shell < .env do repo < NC_HOME/.env), então mesmo numa máquina com ROOT/.env
// real o ambiente é 100% o que este arquivo decidir (padrão do commands.reextract.test.js).
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import OpenAI from 'openai'; // mesma instância de módulo que src/llm.js usa
import { hasCjk, cjkRatio, setLogSink } from '../src/util.js';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-sum-lang-'));
process.env.NC_HOME = NC_HOME_TMP;
for (const k of Object.keys(process.env)) {
  // Env limpo: nada do shell/usuário pode vazar p/ a resolução (mesmo padrão dos outros testes).
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) {
    delete process.env[k];
  }
}
// Semeia o NC_HOME/.env do TMP com as chaves do MOCK (vence o .env do repo real, se existir).
writeFileSync(
  path.join(NC_HOME_TMP, '.env'),
  'LLM_PROVIDER=deepseek\nDEEPSEEK_API_KEY=sk-ds-a\n',
);
process.env.LLM_PROVIDER = 'deepseek'; // o arquivo inteiro exercita o provider DIRETO
process.env.DEEPSEEK_API_KEY = 'sk-ds-a';

const config = await import('../src/config.js');
const llm = await import('../src/llm.js');
const { stmts, db } = await import('../src/db.js');
const { summarizeArticleRow } = await import('../src/summarize.js');
const { flushEvents } = await import('../src/events.js');

// ---- mock do SDK: intercepta `chat.completions.create` e conta as chamadas ----
const Completions = OpenAI.Chat.Completions;
const calls = [];
let createImpl = async () => ({
  model: 'deepseek-v4-flash',
  usage: { prompt_tokens: 10, completion_tokens: 5 },
  choices: [{ message: { content: '{}' } }],
});
mock.method(Completions.prototype, 'create', async function createMock(body, options) {
  calls.push({ body, options });
  return createImpl();
});

const flashUsage = (prompt = 1, completion = 1) => ({ prompt_tokens: prompt, completion_tokens: completion });
// Respostas em FILA: cada chamada ao SDK consome uma; esgotadas, repete a última.
const queue = (payloads) => {
  const q = [...payloads];
  createImpl = async () => {
    const p = q.length ? q.shift() : null;
    return {
      model: 'deepseek-v4-flash',
      usage: flashUsage(),
      choices: [{ message: { content: JSON.stringify(p ?? payloads[payloads.length - 1] ?? {}) } }],
    };
  };
};

// Fixtures: o título/resumo REAL em chinês da captura (id 16) vs a versão PT-BR esperada.
const CJK_TITLE_ONLY = {
  title_pt: '`node:domain` 可能在 Node 27 中运行时弃用', // ANY CJK no título já dispara
  summary_pt: 'A proposta prevê marcar node:domain como obsoleto em runtime no Node 27.',
};
const CJK_SUMMARY = {
  title_pt: '`node:domain` 可能在 Node 27 中运行时弃用',
  summary_pt: '在 Node 27 中，node:domain 可能会在运行时被标记为已弃用，这引发了社区讨论。',
};
const PT_SUMMARY = {
  title_pt: 'node:domain pode ser descontinuado em tempo de execução no Node 27',
  summary_pt:
    'A proposta prevê marcar node:domain como obsoleto em runtime no Node 27. ' +
    'A mudança não afeta a API síncrona atual.',
};
// CJK só num NOME citado dentro do resumo: razão baixa não dispara (threshold 0.25).
const CJK_NAME_SUMMARY = {
  title_pt: 'Ferramenta da Tencent ganha atualização',
  summary_pt: 'A ferramenta 腾讯 (WeChat da Tencent) foi atualizada com suporte a mais plataformas.',
};

const countLangGuardEvents = () =>
  db.prepare("SELECT COUNT(*) c FROM events WHERE stage = 'summarize' AND status = 'language-guard'").get().c;

after(() => {
  mock.restoreAll();
  setLogSink(null);
  db.close();
  config.setRuntimeKey('sk-ds-a', 'deepseek'); // deixa o estado do processo como veio
  rmSync(NC_HOME_TMP, { recursive: true, force: true });
});

// ---- helpers puros (util.js) ----

test('hasCjk: PT-BR limpo NÃO dispara; ZH/JA/KO disparam; vazio/null seguros', () => {
  assert.equal(hasCjk('node:domain pode ser descontinuado no Node 27'), false, 'PT puro');
  assert.equal(hasCjk('TanStack Table: título em português'), false, 'PT com nomes de produto');
  assert.equal(hasCjk('`node:domain` 可能在 Node 27 中运行时弃用'), true, 'chinês (Han)');
  assert.equal(hasCjk('あのニュースレターは更新されました'), true, 'japonês (hiragana/katakana)');
  assert.equal(hasCjk('뉴스레터가 업데이트되었습니다'), true, 'coreano (hangeul)');
  assert.equal(hasCjk(''), false, 'vazio');
  assert.equal(hasCjk(null), false, 'null');
});

test('cjkRatio: 0 em PT puro; ~1 em texto CJK; nome chinês CITADO fica bem abaixo de 0.25', () => {
  assert.equal(cjkRatio('Resumo claro em português do Brasil.'), 0, 'sem CJK -> 0');
  assert.equal(cjkRatio('已经发布'), 1, 'só Han -> 1');
  assert.ok(cjkRatio('在 Node 27 中运行时弃用') > 0.25, 'frase CJK passa do threshold');
  const r = cjkRatio(CJK_NAME_SUMMARY.summary_pt);
  assert.ok(r > 0 && r <= 0.25, `nome citado: razão ${r.toFixed(3)} deve ser pequena (não dispara)`);
});

// ---- summarizeArticle com a guarda (mock do SDK) ----

test('guarda: resposta PT-BR de primeira -> 1 chamada, sem re-try', async () => {
  calls.length = 0;
  queue([PT_SUMMARY]);
  const out = await llm.summarizeArticle({ title: 'node:domain', content: 'corpo' });
  assert.equal(out.title_pt, PT_SUMMARY.title_pt);
  assert.equal(calls.length, 1, 'PT-BR limpo: nenhuma chamada extra');
});

test('guarda: QUALQUER CJK no title_pt dispara o re-try (mesmo com summary limpo) -> 2 chamadas, resultado PT', async () => {
  const warns = [];
  setLogSink((e) => warns.push(e.text));
  calls.length = 0;
  queue([CJK_TITLE_ONLY, PT_SUMMARY]);
  const out = await llm.summarizeArticle({ title: 'node:domain', content: 'corpo' });
  assert.equal(out.title_pt, PT_SUMMARY.title_pt, 're-try devolveu o título PT-BR');
  assert.equal(calls.length, 2, 'CJK no título disparou o re-try');
  assert.ok(
    warns.some((w) => w.includes('CJK') && w.includes('repetindo')),
    `warn do re-try (veio: ${warns.join(' | ')})`,
  );
  setLogSink(null);
});

test('guarda: nome chinês citado no resumo (razão baixa) NÃO dispara re-try', async () => {
  calls.length = 0;
  queue([CJK_NAME_SUMMARY]);
  const out = await llm.summarizeArticle({ title: 'Ferramenta da Tencent', content: 'corpo' });
  assert.equal(out.title_pt, CJK_NAME_SUMMARY.title_pt);
  assert.equal(calls.length, 1, 'nome citado com razão <= 0.25 passa sem re-try');
});

test('guarda: CJK persistente -> THROW após 1 re-try + evento language-guard + ficha fica NULL', async () => {
  const warns = [];
  setLogSink((e) => warns.push(e.text));
  const url = 'https://example.org/artigo-cjk';
  stmts.insertArticle.run({
    source_id: null, url, title: 'node:domain', content: 'corpo do artigo',
    content_hash: 'hash-cjk-persistente', published_at: null, run_id: null,
    kind: 'news', issue_url: null, section: null, blurb: null,
    content_source: 'extract', cleaned: 0, needs_enrich: 0,
  });

  calls.length = 0;
  queue([CJK_SUMMARY]); // a fila repete a última: AMBAS as tentativas em chinês
  await assert.rejects(
    summarizeArticleRow({ id: stmts.getArticleByUrl.get(url).id, title: 'node:domain', content: 'corpo do artigo' }),
    /CJK/,
    'throw com motivo de idioma (o chamador nunca chega ao setSummary)',
  );
  assert.equal(calls.length, 2, 'exatamente 2 admissões (original + 1 re-try; SEM loop infinito)');
  assert.ok(
    warns.some((w) => w.includes('CJK') && w.includes('repetindo')),
    `warn do re-try (veio: ${warns.join(' | ')})`,
  );

  // Evento gravado p/ o `ncrawl inspect` e p/ o backfill da onda 2 localizarem a ficha.
  flushEvents();
  assert.equal(countLangGuardEvents(), 1, 'evento summarize/language-guard persistido');

  // Invariante NULL-only: a linha NÃO foi tocada (nunca se persiste idioma errado).
  const row = db.prepare('SELECT title_pt, summary_pt FROM articles WHERE url = ?').get(url);
  assert.equal(row.title_pt, null, 'title_pt continua NULL');
  assert.equal(row.summary_pt, null, 'summary_pt continua NULL');
  setLogSink(null);
});
