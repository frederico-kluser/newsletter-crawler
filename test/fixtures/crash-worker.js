// Fixture de teste do parse-pool: fala o MESMO protocolo do worker real, mas com ops que
// permitem exercitar caminhos difíceis de forçar com o worker de produção — crash nativo
// (process.exit), trava (timeout) e echo. Só é carregado quando PARSE_WORKER_PATH aponta p/ cá.
import { parentPort } from 'node:worker_threads';

// `node --test` importa qualquer .js sob test/; fora de um worker parentPort é null — no-op.
if (parentPort) parentPort.on('message', ({ id, op, args }) => {
  if (op === 'crash') {
    process.exit(1); // mata o worker no meio da task (simula o SIGSEGV do JSDOM)
    return;
  }
  if (op === 'hang') {
    return; // nunca responde: força o timeout por task do pool
  }
  if (op === 'echo') {
    parentPort.postMessage({ id, ok: true, result: args[0] });
    return;
  }
  parentPort.postMessage({ id, ok: false, error: `op desconhecida: ${op}` });
});
