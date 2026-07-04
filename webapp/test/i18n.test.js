import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOCALE, resolveLocale, SUPPORTED } from '../src/lib/locale.js';
import { DICTS, LOCALE_NAME } from '../src/strings.js';

test('resolveLocale: português (qualquer variante/caixa) → pt', () => {
  assert.equal(resolveLocale(['pt-BR']), 'pt');
  assert.equal(resolveLocale(['pt']), 'pt');
  assert.equal(resolveLocale(['PT-pt']), 'pt');
  assert.equal(resolveLocale('pt-BR'), 'pt'); // aceita string única
  assert.equal(resolveLocale(['en-US', 'pt-BR']), 'pt'); // pt em qualquer posição da lista
});

test('resolveLocale: qualquer outro idioma → en (fallback do produto)', () => {
  for (const l of ['en-US', 'en', 'fr-FR', 'es', 'de-DE', 'ja', 'zh-CN', 'ptx']) {
    assert.equal(resolveLocale([l]), 'en', `${l} deveria cair em en`);
  }
});

test('resolveLocale: entrada vazia/ausente/inválida → default en', () => {
  assert.equal(resolveLocale([]), DEFAULT_LOCALE);
  assert.equal(resolveLocale(undefined), 'en');
  assert.equal(resolveLocale(null), 'en');
  assert.equal(resolveLocale([null, 123, {}]), 'en'); // itens não-string são ignorados
});

test('SUPPORTED e DEFAULT_LOCALE são pt/en e en', () => {
  assert.deepEqual(SUPPORTED, ['pt', 'en']);
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.deepEqual(Object.keys(LOCALE_NAME).sort(), ['en', 'pt']);
});

test('paridade de chaves de UI entre os dicionários pt e en', () => {
  const pt = Object.keys(DICTS.pt).sort();
  const en = Object.keys(DICTS.en).sort();
  assert.deepEqual(en, pt, 'toda chave de UI precisa existir nos DOIS idiomas');
});

test('paridade dos mapas de rótulo (kind/verify/facet)', () => {
  for (const map of ['KIND_LABEL', 'VERIFY_LABEL', 'FACET_LABEL']) {
    assert.deepEqual(
      Object.keys(DICTS.en[map]).sort(),
      Object.keys(DICTS.pt[map]).sort(),
      `${map} precisa das mesmas chaves nos dois idiomas`,
    );
  }
});

test('tutorial: mesmos passos/ícones e todo passo com título + corpo', () => {
  const pt = DICTS.pt.tutorialSteps;
  const en = DICTS.en.tutorialSteps;
  assert.equal(en.length, pt.length);
  assert.deepEqual(en.map((s) => s.icon), pt.map((s) => s.icon));
  for (const step of [...pt, ...en]) {
    assert.ok(step.title && step.body, 'cada passo tem título e corpo não-vazios');
  }
});
