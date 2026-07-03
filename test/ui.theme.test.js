// Smoke puro da camada de tema: tokens presentes e uiTheme recolorindo os widgets do @inkjs/ui
// (foco/spinner/barra → accent). Sem render Ink (ui.menu.test.js já cobre o App sob o provider).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colors, glyphs, space, SPINNER_FRAMES, uiTheme } from '../src/ui/theme.js';

test('tokens semânticos presentes', () => {
  for (const k of ['accent', 'title', 'ok', 'warn', 'err', 'link', 'muted']) assert.ok(colors[k], k);
  for (const k of ['pointer', 'app', 'tick', 'saved', 'cross', 'idle', 'warn', 'rule']) assert.ok(glyphs[k], k);
  assert.ok(space.pad >= 0);
  assert.ok(SPINNER_FRAMES.length > 0);
});

test('uiTheme recolore foco/seleção/spinner/barra para os tokens', () => {
  const sel = uiTheme.components.Select.styles;
  assert.equal(sel.focusIndicator().color, colors.accent);
  assert.equal(sel.label({ isFocused: true, isSelected: false }).color, colors.accent);
  const ms = uiTheme.components.MultiSelect.styles;
  assert.equal(ms.focusIndicator().color, colors.accent);
  assert.equal(ms.selectedIndicator().color, colors.ok);
  assert.equal(ms.label({ isFocused: false, isSelected: true }).color, colors.ok);
  assert.equal(uiTheme.components.Spinner.styles.frame().color, colors.accent);
  assert.equal(uiTheme.components.ProgressBar.styles.completed().color, colors.accent);
});

test('deepmerge preserva as chaves default não sobrescritas', () => {
  assert.equal(typeof uiTheme.components.Select.styles.option, 'function');
  assert.equal(typeof uiTheme.components.MultiSelect.styles.container, 'function');
  assert.equal(typeof uiTheme.components.ProgressBar.config, 'function');
});
