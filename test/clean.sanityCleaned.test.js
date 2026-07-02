// Sanidade da limpeza por IA (anti-alucinação/truncamento) + aplicação de junk_spans
// (remoção local verbatim — a IA só aponta a sujeira, nunca reescreve o texto).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanityCheckCleaned, applyJunkSpans } from '../src/clean.js';

test('applyJunkSpans: remove todas as ocorrências exatas; ignora span não encontrado', () => {
  const orig = 'MENU Home Docs\n' + 'Texto real do artigo. '.repeat(30) + '\nMENU Home Docs\nSubscribe now!';
  const r = applyJunkSpans(orig, ['MENU Home Docs', 'Subscribe now!', 'não existe no texto']);
  assert.equal(r.rejected, false);
  assert.equal(r.applied, 2);
  assert.equal(r.notFound, 1);
  assert.ok(!r.text.includes('MENU Home Docs') && !r.text.includes('Subscribe now!'));
  assert.ok(r.text.includes('Texto real do artigo.'));
});

test('applyJunkSpans: over-deletion é rejeitada (mantém o original)', () => {
  const body = 'Conteúdo importante que não é sujeira. '.repeat(60);
  const r = applyJunkSpans(body, ['Conteúdo importante que não é sujeira. ']);
  assert.equal(r.rejected, true);
  assert.equal(r.text, body);
});

test('applyJunkSpans: lista vazia/spans minúsculos = no-op', () => {
  const orig = 'Texto limpo.' + ' Mais texto real aqui p/ passar do mínimo.'.repeat(10);
  assert.equal(applyJunkSpans(orig, []).applied, 0);
  assert.equal(applyJunkSpans(orig, ['a', '  ']).applied, 0);
});

test('aceita limpeza plausível (removeu sujeira, manteve o corpo)', () => {
  const orig = 'MENU Home Sobre Assine\n' + 'x'.repeat(2000) + '\nRodapé © 2026 Subscribe';
  const cleaned = 'x'.repeat(2000);
  assert.equal(sanityCheckCleaned(orig, cleaned).ok, true);
});

test('rejeita truncamento (saída minúscula p/ um original grande)', () => {
  const r = sanityCheckCleaned('y'.repeat(10000), 'só um parágrafo curto');
  assert.equal(r.ok, false);
  assert.match(r.reason, /curto/);
});

test('rejeita inflação (saída maior que o original) e vazio', () => {
  assert.equal(sanityCheckCleaned('curto', '').ok, false);
  assert.equal(sanityCheckCleaned('a'.repeat(300), 'b'.repeat(1200)).ok, false);
});

test('original curto: limpeza pode devolver quase tudo', () => {
  const orig = 'Uma descrição curta de ferramenta com 80 chars de texto útil e um botão Subscribe';
  const cleaned = 'Uma descrição curta de ferramenta com 80 chars de texto útil';
  assert.equal(sanityCheckCleaned(orig, cleaned).ok, true);
});
