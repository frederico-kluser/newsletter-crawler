// Fixture de teste do parse-pool: fala o MESMO protocolo IPC do processo-filho real (child_process),
// mas com ops que permitem exercitar caminhos difíceis de forçar com o worker de produção — crash
// por SAÍDA (process.exit), SIGSEGV NATIVO REAL (process.kill), trava (timeout) e echo. Só é
// carregado quando PARSE_WORKER_PATH aponta p/ cá.

function handle({ id, op, args }) {
  if (op === 'crash') {
    process.exit(1); // saída não-zero: mata o filho no meio da task
    return;
  }
  if (op === 'segfault') {
    // Proxy DETERMINÍSTICO de um crash nativo TERMINAL (como o SIGSEGV do JSDOM em produção). Usa
    // SIGKILL de propósito: é uncatchable — o Node NÃO o intercepta (ao contrário de um SIGSEGV
    // entregue por kill(), que o handler de diagnóstico do Node CONTINUA, deixando o filho vivo).
    // Assim o filho morre DE VERDADE -> o pool vê 'exit' com signal e respawna (onDeath, rápido).
    // No antigo transporte worker_threads este mesmo sinal mataria o PROCESSO INTEIRO (o "core
    // dumped" do usuário) -> este teste falharia/derrubaria o runner: é a regressão que o trava.
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  if (op === 'hang') {
    return; // nunca responde: força o timeout por task do pool
  }
  if (op === 'echo') {
    process.send({ id, ok: true, result: args[0] });
    return;
  }
  process.send({ id, ok: false, error: `op desconhecida: ${op}` });
}

// `node --test` importa qualquer .js sob test/; fora de um fork process.send é undefined — no-op.
if (typeof process.send === 'function') {
  process.on('message', handle);
  process.on('disconnect', () => process.exit(0)); // pai morto -> sai sozinho (idem worker real)
  process.send({ ready: true });
}
