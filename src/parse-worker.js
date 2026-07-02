// Worker thread de parsing: recebe {id, op, args}, roda a função JSDOM de parse-core e devolve
// {id, ok, result|error}. Um crash NATIVO (SIGSEGV do parser de CSS do JSDOM) mata SÓ este
// worker — o pool (parse-pool.js) detecta o 'exit' e respawna, resolvendo a task em voo com um
// default seguro. Só as ops JSDOM vivem aqui; cheerio/puras rodam no processo principal.
import { parentPort } from 'node:worker_threads';
import { extractArticle, readableLinks, probablyArticle } from './parse-core.js';

const OPS = { extractArticle, readableLinks, probablyArticle };

parentPort.on('message', ({ id, op, args }) => {
  try {
    const fn = OPS[op];
    if (!fn) throw new Error(`op de parse desconhecida: ${op}`);
    parentPort.postMessage({ id, ok: true, result: fn(...args) });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e?.message || String(e) });
  }
});
