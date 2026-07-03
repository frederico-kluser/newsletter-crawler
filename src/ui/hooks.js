// Hooks compartilhados da TUI.
import { useState, useEffect } from 'react';
import { SPINNER_FRAMES } from './theme.js';

// Um só intervalo p/ TODA a animação de um painel (nunca N <Spinner>s do @inkjs/ui, cada um com
// o próprio timer → dessincronia/flicker; o Ink já redesenha a árvore viva inteira a cada state
// change). Regra: no máximo UM glifo animado por árvore — quem precisa de mais, compartilha o frame.
export function useSpinnerFrame(active) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setI((n) => (n + 1) % SPINNER_FRAMES.length), 150);
    id.unref?.(); // animação NUNCA segura o processo vivo (senão trava o node --test)
    return () => clearInterval(id);
  }, [active]);
  return SPINNER_FRAMES[i];
}
