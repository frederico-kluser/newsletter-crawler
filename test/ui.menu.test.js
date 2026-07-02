// Smoke da UI sem TTY real: ink-testing-library renderiza o App p/ string e conferimos os labels
// do menu. (O idioma vem de CRAWLER_LANG no load do módulo; o EN é checado em subprocesso.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { html } from '../src/ui/html.js';
import App from '../src/ui/App.js';

test('UI: o menu lista as ações principais (PT)', () => {
  const { lastFrame, unmount } = render(html`<${App} />`);
  const frame = lastFrame() || '';
  for (const label of [
    'newsletter-crawler', 'Coletar', 'Buscar', 'Status', 'Exportar', 'Classificar', 'Resumir',
    'Adicionar', 'Limites', 'Limpar',
  ]) {
    assert.ok(frame.includes(label), `o menu deve conter "${label}"\n--- frame ---\n${frame}`);
  }
  unmount();
});
