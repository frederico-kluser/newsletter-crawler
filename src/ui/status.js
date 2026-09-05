// Leitura de status TOLERANTE a banco fechado. A tela "Recuperar" repõe uma cópia do banco com
// `backup restore`, e essa receita FECHA a conexão do SQLite no meio da sessão (é obrigatório:
// sem fechar, o -wal vivo é reaplicado por cima do arquivo copiado). Depois disso qualquer
// `getStatus()` lança — e a barra de status do App roda em TODO render, o que derrubaria o Ink
// exatamente na tela que diz "deu certo, agora saia". Aqui o último status bom é lembrado e
// devolvido no lugar; nada na UI precisa saber que o banco fechou.
import { getStatus } from '../commands.js';

const EMPTY = {
  spend: { totalUsd: 0, calls: 0, lastRun: null },
  sources: 0,
  pages: 0,
  articles: 0,
  selectors: 0,
  classified: 0,
  pendingClassif: 0,
  summaries: 0,
  pendingSummary: 0,
  frontier: { pending: 0, in_progress: 0, done: 0, failed: 0 },
};

let last = null;

export function safeStatus() {
  try {
    last = getStatus();
    return last;
  } catch {
    return last || EMPTY; // banco fechado/ilegível: o último snapshot bom, nunca uma exceção
  }
}
