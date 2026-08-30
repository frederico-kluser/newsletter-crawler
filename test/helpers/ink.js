// Helpers de navegação p/ os testes Ink (ink-testing-library). Navegação por LABEL: em vez de
// hard-codar DOWN×N (quebra ao reordenar o menu ou inserir um passo), desce até o ponteiro (❯)
// estar sobre o item e seleciona. Sem sufixo .test. → o node --test ignora este arquivo.
export const keys = { DOWN: '\x1b[B', UP: '\x1b[A', ENTER: '\r', ESC: '\x1b', SPACE: ' ' };
export const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// Espera (POLLING) a condição valer no último frame, com timeout — os waits FIXOS em ms ficam à
// mercê da velocidade da máquina (flaky em máquina carregada): a transição de tela pode levar
// mais de um frame depois do input. Depois de a condição valer, ASSENTA mais um settle antes de
// devolver: o ink-testing-library pinta o frame ANTES de os efeitos do componente recém-montado
// (registro dos useInput do menu/Select/TextInput) rodarem — um input enviado logo após o frame
// aparecer se PERDE (ENTER que não navega, 1º char que não digita). Devolve o último frame
// pré-settle (a condição já valia nele).
export async function waitForFrame(lastFrame, cond, { timeoutMs = 3000, stepMs = 20, settleMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = lastFrame() || '';
    if (cond(last)) {
      await wait(settleMs);
      return last;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return last;
}

// Digita um texto caractere a caractere, com um gap entre cada um. Duas razões (races reais do
// ink-testing-library + @inkjs/ui, ver ui.search.test.js):
//   1. um `stdin.write` com a string INTEIRA faz o TextInput dar submit lendo o valor ANTES de o
//      React ter processado (batched) todos os chars — o display mostra o texto mas o onSubmit
//      recebe '' (ou valor parcial);
//   2. o 1º char pode se PERDER se o write chegar antes de o useInput do TextInput recém-montado
//      registrar no efeito. Por isso o settle INICIAL antes do 1º char (além do settle final
//      antes de um submit seguinte).
export async function typeText(stdin, text, { gapMs = 5 } = {}) {
  await wait(150); // deixa o useInput do TextInput recém-montado registrar
  for (const ch of String(text)) {
    stdin.write(ch);
    await wait(gapMs);
  }
  await wait(30); // assenta o estado do TextInput antes de qualquer submit seguinte
}

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
