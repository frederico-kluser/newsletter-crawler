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

test('provedor LLM (KeyModal): todas as chaves existem nos DOIS dicionários e as variantes Ds são próprias', () => {
  const keys = [
    'keyProviderLabel', 'keyProviderOr', 'keyProviderDeepSeek',
    'keyTitle', 'keyBody', 'keyHint', 'keyPlaceholder', 'keySave', 'keySaving',
    'keyInvalid', 'keyNetwork', 'keyForget', 'keyExpired', 'keyManageTitle', 'keyManageBody',
    'keyBtnHas', 'keyBtnMissing', 'keySaved',
    'keyTitleDs', 'keyBodyDs', 'keyHintDs', 'keyPlaceholderDs',
    'keyInvalidDs', 'keyExpiredDs', 'keyManageTitleDs', 'keyManageBodyDs', 'keyBtnHasDs', 'keyBtnMissingDs',
  ];
  for (const k of keys) {
    assert.ok(typeof DICTS.pt[k] === 'string' && DICTS.pt[k].length > 0, `pt.${k} não-vazio`);
    assert.ok(typeof DICTS.en[k] === 'string' && DICTS.en[k].length > 0, `en.${k} não-vazio`);
  }
  // as variantes Ds existem com texto PRÓPRIO (não são alias vazios/iguais)
  for (const d of [DICTS.pt, DICTS.en]) {
    assert.notEqual(d.keyTitleDs, d.keyTitle);
    assert.notEqual(d.keyInvalidDs, d.keyInvalid);
    assert.notEqual(d.keyExpiredDs, d.keyExpired);
    assert.notEqual(d.keyManageTitleDs, d.keyManageTitle);
    assert.notEqual(d.keyBtnHasDs, d.keyBtnHas);
    assert.notEqual(d.keyBtnMissingDs, d.keyBtnMissing);
  }
  // rótulos do seletor são fixos (ids no KeyModal)
  assert.equal(DICTS.pt.keyProviderOr, 'OpenRouter');
  assert.equal(DICTS.pt.keyProviderDeepSeek, 'DeepSeek');
  assert.equal(DICTS.en.keyProviderOr, 'OpenRouter');
  assert.equal(DICTS.en.keyProviderDeepSeek, 'DeepSeek');
});
