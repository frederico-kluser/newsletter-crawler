// Regressão do P2 (captura Node Weekly 2026-08-14): o zod rodava FORA do callJSON (nos call
// sites), então um shape inválido ("expected array, received undefined" em items/junk_spans)
// derrubava a seção de curadoria da issue 637 e o clean do meiert.com SEM nenhum retry — o
// retry do callJSON só cobria JSON não-parseável. Agora o callJSON aceita `zod:`: JSON ok
// porém fora do schema entra no MESMO fluxo de retry (re-amostra; o default tolerante do
// schema só vale esgotados os retries — na 637, a 2ª tentativa recuperaria a seção).
// Mesmo harness do llm.provider-client.test.js (mock do SDK openai, provider deepseek, ZERO rede).
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import OpenAI from 'openai'; // mesma instância de módulo que src/llm.js usa
import { setLogSink } from '../src/util.js';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-llm-zod-'));
process.env.NC_HOME = NC_HOME_TMP;
for (const k of Object.keys(process.env)) {
  // Env limpo: nada do shell/usuário pode vazar p/ a resolução (mesmo padrão dos outros testes).
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) {
    delete process.env[k];
  }
}
process.env.LLM_PROVIDER = 'deepseek'; // o arquivo inteiro exercita o provider DIRETO
process.env.DEEPSEEK_API_KEY = 'sk-ds-a';
process.on('exit', () => rmSync(NC_HOME_TMP, { recursive: true, force: true }));

const config = await import('../src/config.js');
const llm = await import('../src/llm.js');

// ---- mock do SDK: intercepta `chat.completions.create` e conta as chamadas ----
const Completions = OpenAI.Chat.Completions;
const calls = [];
let createImpl = async () => ({
  model: 'deepseek-v4-flash',
  usage: { prompt_tokens: 10, completion_tokens: 5 },
  choices: [{ message: { content: '{}' } }],
});
mock.method(Completions.prototype, 'create', async function createMock(body, options) {
  calls.push({ body, options, client: this._client });
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

after(() => {
  mock.restoreAll();
  setLogSink(null);
  config.setRuntimeKey('sk-ds-a', 'deepseek'); // deixa o estado do processo como veio
});

const VALID_CURATE = {
  issue_date: null,
  items: [{ url: 'https://x.com/2', title: 'T2', kind: 'news', section: 'Releases', blurb: null }],
};

// ---- (c) zod válido de primeira: 1 chamada só, sem retry ----

test('zod: resposta válida de primeira -> 1 chamada só (nenhum retry)', async () => {
  calls.length = 0;
  queue([{ verdict: 'ok', problems: [] }]);
  const out = await llm.verifyRecordLLM({
    url: 'https://x.com/1', kind: 'news', title: 'T', blurb: 'b', content: 'c',
  });
  assert.equal(out.verdict, 'ok');
  assert.deepEqual(out.problems, []);
  assert.equal(calls.length, 1, 'zod válido: sem retry');
});

// ---- (a) shape inválido na 1ª chamada -> retry -> shape válido (recupera) ----

test('zod: shape inválido (items com tipo errado) na 1ª chamada -> retry recupera a seção', async () => {
  calls.length = 0;
  queue([{ issue_date: null, items: 'string no lugar de array' }, VALID_CURATE]);
  const out = await llm.curateRoundupItems({ markdown: '## Releases\n- a', baseUrl: 'https://x.com' });
  assert.equal(out.items.length, 1, '2ª tentativa recuperou o item');
  assert.equal(out.items[0].url, 'https://x.com/2');
  assert.equal(calls.length, 2, 'duas admissões (shape inválido + retry)');
});

// ---- (d) REGRESSÃO EXATA DO 637: chave tolerada AUSENTE re-amostra (default só esgotado) ----

test('zod: items AUSENTE (o caso 637 "expected array, received undefined") -> retry, não default silencioso', async () => {
  calls.length = 0;
  queue([{ issue_date: null }, VALID_CURATE]); // 1ª resposta sem items — a 2ª tentativa recupera
  const out = await llm.curateRoundupItems({ markdown: '## Releases\n- a', baseUrl: 'https://x.com' });
  assert.equal(out.items.length, 1, '2ª tentativa recuperou a seção inteira');
  assert.equal(calls.length, 2, 'chave tolerada ausente conta como shape inválido e re-amostra');
});

// ---- (b) esgotados os retries: defaults tolerantes SEM throw (items [], junk_spans []) ----

test('zod: esgotado -> defaults tolerantes SEM throw (curateZ.items vira [])', async () => {
  const warns = [];
  setLogSink((e) => warns.push(e.text));
  calls.length = 0;
  queue([{ issue_date: null, items: 'sempre errado' }]); // todas as tentativas com shape inválido
  const out = await llm.curateRoundupItems({ markdown: '## Releases\n- a', baseUrl: 'https://x.com' });
  assert.deepEqual(out.items, [], 'items default []: a seção fica vazia, não cai');
  assert.equal(out.issue_date, null);
  assert.equal(calls.length, 3, 'retries default 2: 3 admissões antes de aplicar o default');
  assert.ok(
    warns.some((w) => w.includes('resposta fora do schema') && w.includes('aplicando defaults tolerantes')),
    `warn dos defaults tolerantes (veio: ${warns.join(' | ')})`,
  );
  setLogSink(null);
});

test('zod: esgotado -> cleanZ.junk_spans default [] (o caso do meiert.com)', async () => {
  calls.length = 0;
  queue([{ title: null, junk_spans: 'errado', published_at: null }]);
  const out = await llm.cleanArticleContent({ title: 'T', content: 'corpo' });
  assert.deepEqual(out.junk_spans, [], 'junk_spans default []: o original cru NÃO é salvo sem limpeza');
  assert.equal(calls.length, 3, '3 admissões antes de aplicar o default');
});

test('zod: esgotado -> verifyZ.problems default []', async () => {
  calls.length = 0;
  queue([{ verdict: 'suspect' }]); // problems ausente em TODAS as tentativas
  const out = await llm.verifyRecordLLM({
    url: 'https://x.com/1', kind: 'news', title: 'T', blurb: 'b', content: 'c',
  });
  assert.equal(out.verdict, 'suspect');
  assert.deepEqual(out.problems, [], 'problems default []: verify sobrevive a shape inválido');
  assert.equal(calls.length, 3);
});

test('zod: item malformado persistente zera a coleção inteira (fail-open p/ o passe de cobertura)', async () => {
  // Documenta o comportamento tolerante: um item sem título derruba o array todo -> items []
  // (o passe de cobertura da curadoria recupera; melhor do que derrubar a etapa).
  calls.length = 0;
  queue([{ issue_date: null, items: [{ url: 'https://x.com/2', kind: 'news' }] }]); // sem title
  const out = await llm.curateRoundupItems({ markdown: '## Releases\n- a', baseUrl: 'https://x.com' });
  assert.deepEqual(out.items, [], 'coleção com item inválido zera p/ [] (documentado)');
  assert.equal(calls.length, 3);
});

// ---- fluxos coexistem: JSON não-parseável segue o retry histórico mesmo com zod ----

test('zod: JSON inválido continua no fluxo de retry histórico (parse falhou -> re-amostra)', async () => {
  calls.length = 0;
  queue(['texto sem json', VALID_CURATE]);
  const out = await llm.curateRoundupItems({ markdown: '## Releases\n- a', baseUrl: 'https://x.com' });
  assert.equal(out.items.length, 1, 'retry do JSON inválido recupera mesmo com zod presente');
  assert.equal(calls.length, 2);
});
