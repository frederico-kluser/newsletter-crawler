// Guarda de RECUSA/meta-texto (`isRefusalText`, src/util.js) — "Artigo não fornecido",
// "Nenhum artigo fornecido" e familiares nunca mais voltam a ser `content`/`title_pt`/`summary_pt`
// (medido 2026-10-15: 324 fichas no acervo com estas desculpas dos modelos de extração/resumo).
// Casos REAIS do acervo + os falsos positivos que NÃO podem casar (notícias legítimas que
// mencionam "não exaustiva"/"não contém vulnerabilidades"/"500 error responses").
// Mais as regressões dos guardas de página re-apertados (isErrorPage/isBlockedPage em parse-core).
process.env.CRAWLER_LANG = '';

// CONTRATO DE ISOLAMENTO: NC_HOME tmp ANTES do 1º import que alcança config.js (o tripwire dos
// testes reprova qualquer ficheiro que use o NC_HOME REAL do usuário).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-refusal-'));
process.env.NC_HOME = NC_HOME_TMP;
process.on('exit', () => rmSync(NC_HOME_TMP, { recursive: true, force: true }));

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isRefusalText } = await import('../src/util.js');
const { isErrorPage, isBlockedPage, looksLikeJson } = await import('../src/parse-core.js');

const RECUSAS = [
  'Artigo não fornecido. Por favor, cole o conteúdo do artigo para que eu possa traduzir.',
  'Artigo não fornecido',
  'Nenhum artigo fornecido',
  'Nenhum artigo foi fornecido para tradução e resumo.',
  'Erro: Nenhum artigo fornecido',
  'Erro: artigo não fornecido',
  'O artigo não foi fornecido na mensagem.',
  'Não foi fornecido o artigo para tradução e resumo.',
  'Não recebi o artigo. Por favor, cole o texto para que eu possa traduzir.',
  'O artigo não pôde ser exibido. A mensagem indica que o conteúdo não está disponível.',
  'O conteúdo do artigo não foi fornecido. Por favor, envie o texto completo.',
  'Não foi possível gerar o resumo porque o texto do artigo não foi fornecido.',
  'Não foi possível realizar a tradução e o resumo porque o artigo não foi fornecido.',
  'O texto fornecido não contém um artigo sobre ponteiros em Go. Em vez disso, ...',
  'O texto fornecido não é um artigo; é uma mensagem de verificação de página web.',
  'Este conteúdo não apresenta um artigo principal. O HTML fornecido contém apenas ...',
  'O resumo não pode ser produzido porque o conteúdo fornecido não contém um artigo.',
  'Um resumo do artigo não foi fornecido.',
  'O conteúdo do artigo não pôde ser acessado no momento, pois o servidor retornou um erro 403.',
  'The article was not provided.',
  'Article not provided',
];

const LEGITIMOS = [
  'O artigo apresenta uma lista não exaustiva de projetos e empresas que adotaram Rust.',
  'O que acontece quando a IA fica sem conteúdo para roubar?',
  'O título indica que a Anthropic registou uma patente sobre modelos de linguagem.',
  'O resumo não pode ser produzido sem colaboração dos editores, diz o autor do estudo.',
  'O artigo não contém vulnerabilidades conhecidas na versão 2.0 da biblioteca.',
  'Node.js 24.19.0 traz melhorias no runtime e atualizações de dependências.',
  'O artigo fornecido pelo autor foi bem recebido pela comunidade de especialistas.',
  'Não foi possível gerar previsões confiáveis para o próximo trimestre, diz a empresa.',
  'Não foi fornecido um parecer sobre o caso, diz o juiz da comarca central.',
  'A empresa pediu que por favor envie o relatório à direção antes da reunião de sexta.',
];

test('isRefusalText: apanha TODAS as formas de recusa do acervo (PT + EN)', () => {
  for (const t of RECUSAS) assert.equal(isRefusalText(t), true, `devia ser recusa: ${t.slice(0, 60)}`);
});

test('isRefusalText: NOTÍCIAS legítimas nunca casam (o triplo crivo)', () => {
  for (const t of LEGITIMOS) assert.equal(isRefusalText(t), false, `NÃO devia casar: ${t.slice(0, 60)}`);
});

test('isRefusalText: vazio/NULL não é recusa; a detecção é só no COMEÇO do texto', () => {
  assert.equal(isRefusalText(''), false);
  assert.equal(isRefusalText(null), false);
  const cita = 'O debate sobre padrões abertos é longo. Alguns dizem "artigo não fornecido" como piada, mas o resto do texto é prosa normal sobre APIs.';
  assert.equal(isRefusalText(cita), false, 'menção pelo MEIO não é recusa — a recusa é o texto todo');
});

test('isErrorPage: páginas de erro com corpo GRANDE (403 ERROR / Apologies / 404) também contam', () => {
  assert.equal(isErrorPage('Apple bets on auto-deleting chats', '403 ERROR\n\nRequest blocked.\nWe can\'t connect to the server for this app or website at this time.'), true);
  assert.equal(isErrorPage("Go's Inlining Strategy", 'Apologies, but something went wrong on our end. Refresh the page, check Medium\'s site status.'), true);
  assert.equal(isErrorPage('The request could not be satisfied', '404 This page could not be found. The page may have been moved or deleted.'), true);
  // notícia sobre erros HTTP NÃO é página de erro (a ordem é "error 500", nunca "500 error";
  // e a regra de corpo curto não conta — aqui há lede real, >100 chars)
  assert.equal(
    isErrorPage(
      'Why 500 error responses plague APIs',
      '500 error responses plague APIs everywhere and cost teams millions of dollars in downtime, but most engineers never learn why they happen or how to recover quickly from them.',
    ),
    false,
  );
  assert.equal(isErrorPage('Um guia de deploy', 'Este artigo explica como publicar a aplicação em produção com segurança e sem downtime.'), false);
});

test('isBlockedPage: prosa comum "…for just a moment" não é interstitial (regressão #9998)', () => {
  const artigo = 'Asleep at the wheel: More Tesla owners are choosing to nap while their cars drive\n' +
    'Tesla owners are becoming more brazen about their willingness to shut their eyes.\n\n' +
    'Lately, Josh has found a new way to pass the time on the road: napping.\n\nJust a moment.\nWe are getting your experience ready.';
  assert.equal(isBlockedPage('Tesla owners are posting videos', artigo), false);
  // o interstitial REAL continua a ser apanhado (frases fortes + "Just a moment" a começar LINHA)
  assert.equal(isBlockedPage('Just a moment...', 'Just a moment...\nEnable JavaScript and cookies to continue'), true);
  assert.equal(isBlockedPage('Attention Required! | Cloudflare', 'Attention Required!\nPlease enable cookies.\nYou have been blocked'), true);
});

test('looksLikeJson: blob de dados é JSON, prosa não', () => {
  assert.equal(looksLikeJson('{"title": "Bun v1.4", "body": "we can\'t ship"}'), true);
  assert.equal(looksLikeJson('Bun v1.4 will be our biggest jump in Node.js compatibility since 1.0'), false);
});
