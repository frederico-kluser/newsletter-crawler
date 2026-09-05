// PARIDADE de chaves do i18n da TUI: toda string nova entra nos DOIS idiomas (regra do projeto).
// Sem este teste, uma chave só em PT some silenciosamente em CRAWLER_LANG=en (o `t()` cai no
// fallback PT e o inglês fica meio traduzido). Módulo PURO — nenhum DB, nenhum Ink.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { DICT, t } = await import('../src/ui/i18n.js');

test('PT e EN têm exatamente as MESMAS chaves', () => {
  const pt = Object.keys(DICT.pt).sort();
  const en = Object.keys(DICT.en).sort();
  const faltamNoEn = pt.filter((k) => !DICT.en[k]);
  const faltamNoPt = en.filter((k) => !DICT.pt[k]);
  assert.deepEqual(faltamNoEn, [], `chaves sem tradução EN: ${faltamNoEn.join(', ')}`);
  assert.deepEqual(faltamNoPt, [], `chaves sem original PT: ${faltamNoPt.join(', ')}`);
  assert.deepEqual(pt, en);
});

test('nenhuma string fica vazia e os placeholders {x} casam entre os idiomas', () => {
  const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(DICT.pt)) {
    assert.ok(String(DICT.pt[key]).trim(), `PT vazio: ${key}`);
    assert.ok(String(DICT.en[key]).trim(), `EN vazio: ${key}`);
    assert.deepEqual(vars(DICT.en[key]), vars(DICT.pt[key]), `placeholders diferentes em "${key}"`);
  }
});

test('as chaves das telas destrutivas/de recuperação existem nos dois idiomas', () => {
  const novas = [
    'menuMaintenance', 'maintenanceDesc', 'maintBackup', 'maintRestore', 'resetDanger',
    'resetImpactTitle', 'resetSiteWarn', 'resetBackupNote', 'resetContinue', 'resetTypePrompt',
    'resetTypeHint', 'resetTypeMismatch', 'resetEmptyBase', 'cancel', 'srcRemoveTypePrompt',
    'srcRemoveMismatch', 'srcRemoveEmptyArm', 'srcRemoveBackupNote', 'menuBackup', 'backupCreate',
    'backupCount', 'backupEmpty', 'backupCreated', 'backupNothing', 'backupFailed',
    'backupUnreadable', 'backupMore', 'menuRestore', 'restoreOrigin', 'restoreFromGit',
    'restoreFromFile', 'restoreSlowWarn', 'restoreLiveWarn', 'restoreNoGit', 'restoreDry',
    'restoreGo', 'restorePickFile', 'restoreLatest', 'restoreBest', 'restoreSameNote',
    'restoreDiffNote', 'restoreOther', 'restoreNoBackups', 'restoreFileConfirm', 'restoreFileNote',
    'restoreFileGo', 'restoreWorking', 'restoreDone', 'restoreRestart', 'restoreQuit',
    'restoreFailed', 'sinceHint', 'sinceFloorWarn', 'sinceFloorPick', 'sinceFloorKeep',
    'deployModeShrink', 'deployShrinkWarn',
  ];
  for (const k of novas) {
    assert.ok(DICT.pt[k], `chave PT ausente: ${k}`);
    assert.ok(DICT.en[k], `chave EN ausente: ${k}`);
    assert.notEqual(DICT.en[k], DICT.pt[k], `"${k}" não foi traduzido (EN == PT)`);
  }
});

test('t() interpola as variáveis (e não deixa {placeholder} na tela)', () => {
  const s = t('resetTypePrompt', { n: 3249 });
  assert.ok(s.includes('3249'));
  assert.ok(!s.includes('{n}'));
});
