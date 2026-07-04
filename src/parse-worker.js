// Processo-filho de parsing (child_process/fork): recebe {id, op, args} por IPC, roda a função
// JSDOM de parse-core e devolve {id, ok, result|error}. Rodar em PROCESSO separado (não worker
// thread) é o que de fato isola um SIGSEGV NATIVO do parser de CSS do JSDOM: o crash mata SÓ este
// processo — o pool (parse-pool.js) vê o 'exit' com signal e respawna, resolvendo a task em voo
// com um default seguro. worker_threads NÃO isolam segfault (threads compartilham o processo).
// Só as ops JSDOM vivem aqui; cheerio/puras rodam no processo principal.
import { extractArticle, readableLinks, probablyArticle } from './parse-core.js';

const OPS = { extractArticle, readableLinks, probablyArticle };

function handle({ id, op, args }) {
  try {
    const fn = OPS[op];
    if (!fn) throw new Error(`op de parse desconhecida: ${op}`);
    process.send({ id, ok: true, result: fn(...args) });
  } catch (e) {
    process.send({ id, ok: false, error: e?.message || String(e) });
  }
}

// Só opera como filho de IPC (fork): fora disso (import avulso/smoke) process.send é undefined e
// isto vira no-op. O {ready:true} é o handshake — o pool só atribui tasks depois de recebê-lo.
if (typeof process.send === 'function') {
  process.on('message', handle);
  // Pai morto abruptamente (crash/SIGKILL, sem closeParsePool): o canal IPC cai -> sai sozinho p/
  // não virar órfão. Cobre até o filho OCUPADO num loop nativo, que só nota ao voltar ao loop.
  process.on('disconnect', () => process.exit(0));
  process.send({ ready: true }); // handshake: o pool só atribui tasks depois de recebê-lo
}
