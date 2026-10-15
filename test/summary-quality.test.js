// Camada de LEITURA (title_pt/summary_pt) SEMPRE em PT-BR e legível — regra do produto 2026-10-10.
// O guarda antigo só apanhava CJK; resumos em inglês/lixo passavam (15 em EN + ~70 duvidosos
// medidos no acervo). Hoje: (1) looksPortuguese rejeita EN/estrangeiro dominante, (2)
// stripDisplayJunk remove tags/entidades/markdown-link preservando citações de código em backticks,
// (3) o summarize aplica o strip ANTES do guarda e re-amostra + lança em idioma errado.
// Mesmo harness do llm.zod-retry.test.js (mock do SDK openai, ZERO rede).
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import { setLogSink } from '../src/util.js';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-summary-lang-'));
process.env.NC_HOME = NC_HOME_TMP;
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LLM_') || k.startsWith('DEEPSEEK_') || k.startsWith('OPENROUTER_')) delete process.env[k];
}
process.env.LLM_PROVIDER = 'deepseek';
process.env.DEEPSEEK_API_KEY = 'sk-ds-a';
process.env.LLM_TIMEOUT_MS = '5000';
process.on('exit', () => rmSync(NC_HOME_TMP, { recursive: true, force: true }));

const { looksPortuguese, stripDisplayJunk } = await import('../src/util.js');
const { summarizeArticle } = await import('../src/llm.js');

const calls = [];
let createImpl = async () => ({});
mock.method(OpenAI.Chat.Completions.prototype, 'create', async function createMock(body, options) {
  calls.push({ body, options });
  return createImpl(body, options);
});
setLogSink(() => {});
after(() => setLogSink(null));

const resp = (title, summary) => async () => ({
  model: 'm',
  usage: { prompt_tokens: 10, completion_tokens: 20 },
  choices: [{ message: { content: JSON.stringify({ title_pt: title, summary_pt: summary }) } }],
});

test('looksPortuguese: PT/EN/curto-neutro', () => {
  assert.equal(looksPortuguese('O pnpm 11.23 traz melhorias na configuração de registries para projetos novos.'), true);
  assert.equal(looksPortuguese('The text covers the Advent of Linux and the tools that you can use.'), false);
  assert.equal(looksPortugesesafe('Deno 2.9'), true, 'curto/neutro não reprova');
  // Código/identificadores técnicos NÃO contam para o idioma (PRs de Rust/Clippy: texto PT cheio
  // de identificadores EN — o guarda marcava resumos perfeitos como "fora do PT-BR").
  assert.equal(
    looksPortuguese('Este PR melhora o lint `explicit_counter_loop` do Clippy. Quando a variável do loop não é usada (como em `for _ in 0..n`) e o contador é incrementado, sugerimos `.take(n)`.'),
    true,
    'PT com identificadores de código é PT',
  );
  assert.equal(
    looksPortuguese('Ajustar `manual_is_variant_and` para cobrir `manual is_none_or`, removendo usos desnecessários de `map_or` e simplificando o padrão no compilador.'),
    true,
  );
  assert.equal(
    looksPortuguese('useless_conversion: ignorar From::from em código gerado'),
    true,
    'caminhos Rust/C++ (From::from) também não contam para o idioma — título técnico é PT',
  );
});

function looksPortugesesafe(t) { return looksPortuguese(t); } // alias p/ clareza do assert acima

test('stripDisplayJunk: tags e markdown-links saem; backticks de código ficam; entidades decodificam', () => {
  assert.equal(stripDisplayJunk('Veja o <strong>guia</strong> em [docs](https://x.com/a) agora'), 'Veja o guia em docs agora');
  assert.equal(stripDisplayJunk('O tipo `Array<string>` e a tag `<div>` ficam'), 'O tipo `Array<string>` e a tag `<div>` ficam');
  // Entidades construídas por CONCATENAÇÃO: o código-fonte nunca contém o padrão crua (mesma
  // lição do GH013 com tokens — e o input do harness também descodifica entidades literais).
  const amp = '&' + 'amp;';
  const nbsp = '&' + 'nbsp;';
  const num = '&' + '#' + '233;';
  const ent = stripDisplayJunk(`A ${amp} B${nbsp}C ${num} fim`);
  assert.equal(ent, 'A & B C é fim', `entidades decodificadas: ${ent}`);
  assert.equal(stripDisplayJunk('  espaços   em \n excesso  '), 'espaços em excesso');
});

test('summarize: resumo em ENGLISH re-amostra e, persistindo, LANÇA (ficha fica NULL)', async () => {
  calls.length = 0;
  createImpl = resp('The Advent of Linux', 'The text covers the Advent of Linux and you can use it.');
  await assert.rejects(() => summarizeArticle({ title: 'x', content: 'y' }), /fora do PT-BR/);
  assert.equal(calls.length, 2, 'tentativa + re-amostra com o reforço de idioma');
});

test('summarize: CJK continua a ser rejeitado (regressão)', async () => {
  calls.length = 0;
  createImpl = resp('腾讯云的新版本', '腾讯云发布了新版本');
  await assert.rejects(() => summarizeArticle({ title: 'x', content: 'y' }), /fora do PT-BR/);
});

test('summarize: PT com lixo de display é LIMPADO antes de voltar', async () => {
  calls.length = 0;
  createImpl = resp(
    'Lançamento da <b>nova</b> versão',
    'O pnpm 11.23 traz melhorias na configuração de registries. Veja [o guia](https://ex.com/g) e a tag `<div>`.',
  );
  const out = await summarizeArticle({ title: 'x', content: 'y' });
  assert.equal(out.title_pt, 'Lançamento da nova versão', 'tag HTML removida do título');
  assert.ok(!out.summary_pt.includes('<b>') && !out.summary_pt.includes(']('), 'sem tags nem markdown-link');
  assert.ok(out.summary_pt.includes('`<div>`'), 'citação de código em backticks preservada');
  assert.equal(calls.length, 1, 'sem retry: idioma estava certo');
});

test('summarize: RECUSA ("Artigo não fornecido") re-amostra e, persistindo, LANÇA (ficha fica NULL)', async () => {
  calls.length = 0;
  createImpl = resp(
    'Artigo não fornecido',
    'Não foi possível gerar o resumo porque o artigo não foi fornecido. Por favor, envie o texto.',
  );
  await assert.rejects(() => summarizeArticle({ title: 'x', content: '' }), /recusa/);
  assert.equal(calls.length, 2, 'tentativa + re-amostra; nunca persiste a recusa');
});

test('summarize: recusa é rejeitada MESMO em PT-BR legível (o guarda de idioma deixava passar)', async () => {
  calls.length = 0;
  createImpl = resp('Nenhum artigo fornecido', 'O conteúdo do artigo não foi fornecido.');
  await assert.rejects(() => summarizeArticle({ title: 'x', content: '' }), /recusa/);
});

test('summarize: o prompt leva o BLURB do agregador (itens sem corpo resumem do que existe)', async () => {
  calls.length = 0;
  createImpl = resp('Hono 5.0 RC', 'O Hono v5 mantém o núcleo pequeno e reorganiza o resto da estrutura.');
  await summarizeArticle({ title: 'Hono 5.0 RC', content: '', blurb: 'Hono v5 keeps the core small and moves the rest around it.' });
  const enviado = JSON.stringify(calls[0].body);
  assert.ok(enviado.includes('Hono v5 keeps the core small'), 'blurb presente no prompt');
  assert.ok(enviado.includes('RESUMO DO AGREGADOR'), 'seção do blurb marcada');
  assert.equal(calls.length, 1, 'sem retry');
});

test('summarize: o prompt leva o ARTIGO INTEIRO (regressão da cadeia de + truncada — PR #8)', async () => {
  // Um '+' em falta no fim de uma linha trunca a cadeia em silêncio (a resto vira statement
  // pendurado que o runtime descarta) e o modelo recebia as INSTRUÇÕES SEM O ARTIGO — e respondia
  // "Artigo não fornecido". Este assert fecha essa porta de vez.
  calls.length = 0;
  createImpl = resp('Título bom', 'Resumo bom em português sobre o artigo em questão.');
  await summarizeArticle({ title: 'Título da matéria', content: 'CORPO-DO-ARTIGO-COMPLETO', blurb: 'b' });
  const enviado = JSON.stringify(calls[0].body);
  assert.ok(enviado.includes('ARTIGO'), 'secção ARTIGO presente');
  assert.ok(enviado.includes('Título da matéria'), 'título presente no prompt');
  assert.ok(enviado.includes('CORPO-DO-ARTIGO-COMPLETO'), 'conteúdo presente no prompt');
  assert.ok(enviado.includes('Devolva SOMENTE JSON'), 'instruções FINAIS também foram (a cadeia não truncou)');
});
