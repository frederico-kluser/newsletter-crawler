// Helpers de navegação p/ os testes Ink (ink-testing-library). Navegação por LABEL: em vez de
// hard-codar DOWN×N (quebra ao reordenar o menu ou inserir um passo), desce até o ponteiro (❯)
// estar sobre o item e seleciona. Sem sufixo .test. → o node --test ignora este arquivo.
export const keys = { DOWN: '\x1b[B', UP: '\x1b[A', ENTER: '\r', ESC: '\x1b', SPACE: ' ' };
export const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));

export const pointerLine = (frame) => (frame || '').split('\n').find((l) => l.includes('❯')) || '';

// Casa o label como palavra inteira ("Buscar" NÃO casa em "Buscador web").
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const lineHasLabel = (line, label) => new RegExp(`${esc(label)}(?!\\p{L})`, 'u').test(line);

export async function selectMenuItem(stdin, lastFrame, label, { max = 15 } = {}) {
  for (let i = 0; i < max; i++) {
    if (lineHasLabel(pointerLine(lastFrame()), label)) {
      stdin.write(keys.ENTER);
      await wait(60);
      return;
    }
    stdin.write(keys.DOWN);
    await wait(30);
  }
  throw new Error(`item de menu não alcançado: ${label}\n${lastFrame()}`);
}
