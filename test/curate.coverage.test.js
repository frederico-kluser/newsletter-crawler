// Régua do passe de COBERTURA da curadoria (onda3 — TWIR): o teto do guard deixou de ser o
// FIXO 40 (que nunca engatava numa edição do This Week in Rust) e virou `coverageLeftoverCeiling`,
// escalado pelo volume que o 1º passe emitiu e limitado por um teto absoluto; e a régua
// determinística do item recuperado (`isRealRecoveredItem`) passou a aceitar item de LISTA PURA
// (link solto sem blurb — o formato típico do TWIR) sem afrouxar nada das recusas atuais.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// NC_HOME temporário ANTES do import (curate.js importa db.js).
process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-curate-coverage-'));
const { coverageLeftoverCeiling, isRealRecoveredItem } = await import('../src/curate.js');
const { db } = await import('../src/db.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

// Evidência do TWIR (docs/sources/this-week-in-rust.md §3, issue 666 real): 239 links externos
// no corpo bruto (`linksInHtml`) e os agentes de curadoria emitem 15–40 itens → leftovers
// ≈ 90–224 (a faixa "~90–200" da análise). O teto antigo fixo (40) nunca disparava com isso.
const TWIR_BODY_EXTERNAL_LINKS = 239;

test('coverageLeftoverCeiling: emitted pequeno → teto mínimo de 40 (comportamento antigo)', () => {
  assert.equal(coverageLeftoverCeiling(0), 40);
  assert.equal(coverageLeftoverCeiling(1), 40);
  assert.equal(coverageLeftoverCeiling(2), 40);
});

test('coverageLeftoverCeiling: emitted grande → teto escalado, nunca acima de COVERAGE_MAX_LEFT', () => {
  assert.equal(coverageLeftoverCeiling(15), 300); // pior caso TWIR: teto 300 ≥ 224 leftovers
  assert.equal(coverageLeftoverCeiling(40), 600);
  assert.equal(coverageLeftoverCeiling(100), 600); // 100*20 = 2000 → teto absoluto 600
  assert.equal(coverageLeftoverCeiling(10_000), 600); // "dezenas de milhares" → preso no teto
});

test('coverageLeftoverCeiling: volume real do TWIR (239 links externos) → passe DISPARA', () => {
  // Para TODA a faixa documentada de emissão (15–40 itens), os leftovers passam do teto antigo
  // (regressão que este fix ataca) mas cabem no teto escalado novo.
  for (let emitted = 15; emitted <= 40; emitted++) {
    const leftovers = TWIR_BODY_EXTERNAL_LINKS - emitted;
    assert.ok(leftovers > 40, `teto fixo antigo pularia (${leftovers} > 40)`);
    assert.ok(
      leftovers <= coverageLeftoverCeiling(emitted),
      `coverageLeftoverCeiling(${emitted}) deve admitir ${leftovers} leftovers`,
    );
  }
  // Edição MAIOR que a medida (≈300 links externos) com emissão mínima ainda dispara.
  assert.ok(300 - 15 <= coverageLeftoverCeiling(15));
  // Página-ARQUIVO com dezenas de milhares de links segue protegida (o passe não é re-coleta):
  // mesmo que os agentes emitiscem 100 itens, os leftovers ficam MUITO acima do teto absoluto.
  assert.ok(30_000 - 100 > coverageLeftoverCeiling(100));
});

test('isRealRecoveredItem: item de LISTA PURA do TWIR (sem blurb) entra com título específico', () => {
  assert.equal(isRealRecoveredItem({ title: 'Announcing Rust 1.89.0', blurb: null }), true);
  assert.equal(isRealRecoveredItem({ title: 'cargo-semver-checks 0.41', blurb: '' }), true);
  assert.equal(isRealRecoveredItem({ title: 'SheetJS: Read, Edit and Export Excel', blurb: '   ' }), true, 'blurb só espaço = lista pura');
});

test('isRealRecoveredItem: recusas atuais MANTIDAS (genérico, título curto, blurb raso)', () => {
  // Âncora genérica: fora com ou sem blurb (GENERIC_ANCHOR_RE intacto).
  assert.equal(isRealRecoveredItem({ title: 'Demo.', blurb: null }), false);
  assert.equal(isRealRecoveredItem({ title: 'Release notes', blurb: 'x'.repeat(50) }), false);
  assert.equal(isRealRecoveredItem({ title: 'GitHub', blurb: null }), false);
  assert.equal(isRealRecoveredItem({ title: 'More info', blurb: null }), false);
  // Título curto demais: fora em lista pura E com blurb.
  assert.equal(isRealRecoveredItem({ title: 'GTK', blurb: null }), false);
  assert.equal(isRealRecoveredItem({ title: 'GTK', blurb: 'toolkit citado de passagem' }), false);
  // Blurb presente porém raso (< 30): segue fora (só a AUSÊNCIA de blurb abre a lista pura).
  assert.equal(isRealRecoveredItem({ title: 'Wasp framework', blurb: 'curto' }), false);
  // Item de destaque com blurb real (>= 30) segue entrando — régua antiga preservada.
  assert.equal(
    isRealRecoveredItem({
      title: '37 Node CLI App Best Practices',
      blurb: 'A long-standing, but now modernized, set of guidelines for building CLI tools.',
    }),
    true,
  );
});