// Pool de workers de parsing (worker_threads). Isola o JSDOM do processo principal: um SIGSEGV
// do parser de CSS do JSDOM mata só o worker; o pool respawna e a task em voo resolve p/ um
// DEFAULT SEGURO (o chamador degrada — usa content-selector/LLM ou mantém o blurb). NÃO
// re-executa a task que crashou inline (isso arriscaria derrubar o processo principal).
//
// Tamanho PARSE_WORKERS; timeout por task PARSE_TIMEOUT_MS. Sem worker disponível (ambiente sem
// worker_threads, arquivo ausente, ou PARSE_IN_WORKERS=false), roda INLINE no processo principal
// (comportamento antigo). Os workers são unref'd: não seguram o processo vivo ao fim.
import { Worker } from 'node:worker_threads';
import * as core from './parse-core.js';
import { PARSE_WORKERS, PARSE_TIMEOUT_MS, PARSE_IN_WORKERS } from './config.js';
import { warn, debug } from './util.js';

// Caminho do worker (env PARSE_WORKER_PATH permite trocar o worker — usado nos testes p/ um
// fixture que crasha de propósito e exercitar o respawn; produção usa o default).
const WORKER_URL = process.env.PARSE_WORKER_PATH
  ? new URL(process.env.PARSE_WORKER_PATH, import.meta.url)
  : new URL('./parse-worker.js', import.meta.url);
const MAX_SPAWN_FAILS = 3; // após isso, desiste do pool e vai 100% inline

// Roda a função de parse-core diretamente no processo principal (fallback / pool desligado).
function runInline(op, args, safeDefault) {
  try {
    return core[op](...args);
  } catch (e) {
    debug(`parse inline (${op}) falhou: ${e.message}`);
    return safeDefault;
  }
}

const state = {
  disabled: !PARSE_IN_WORKERS,
  spawnFails: 0,
  seq: 0,
  workers: [], // { worker, task }  (task = a task em voo deste worker, ou null)
  queue: [], // tasks aguardando um worker: { id, op, args, safeDefault, resolve, timer }
};

function settle(task, value) {
  if (task._done) return;
  task._done = true;
  if (task.timer) clearTimeout(task.timer);
  task.resolve(value);
}

function removeWorker(rec) {
  const i = state.workers.indexOf(rec);
  if (i >= 0) state.workers.splice(i, 1);
  rec.worker.removeAllListeners();
  rec.worker.terminate().catch(() => {});
}

function spawn() {
  let worker;
  try {
    worker = new Worker(WORKER_URL);
  } catch (e) {
    state.spawnFails++;
    warn(`parse-pool: falha ao subir worker (${e.message}); ${state.spawnFails}/${MAX_SPAWN_FAILS}`);
    if (state.spawnFails >= MAX_SPAWN_FAILS) {
      state.disabled = true;
      warn('parse-pool: desativado — parsing seguirá INLINE no processo principal.');
    }
    return null;
  }
  worker.unref(); // ocioso não segura o processo vivo; assign() faz ref() enquanto há task
  const rec = { worker, task: null };

  worker.on('message', ({ id, ok, result, error }) => {
    const task = rec.task;
    if (!task || task.id !== id) return; // mensagem órfã (task já resolvida por timeout)
    rec.task = null;
    // Volta a não segurar o event loop: worker ocupado é ref'd (senão, numa janela em que SÓ
    // há parses em voo — sem sockets/timers ref'd — o loop esvazia e o processo sai no meio).
    worker.unref();
    if (!ok) debug(`parse (${task.op}) erro no worker: ${error}`);
    settle(task, ok ? result : task.safeDefault);
    pump();
  });

  const onDeath = (why) => {
    const task = rec.task;
    rec.task = null;
    removeWorker(rec);
    if (task) {
      // NÃO re-executa inline: se a task crashou o worker, rodá-la no main arriscaria derrubar
      // o processo. Resolve com o default seguro — o chamador degrada graciosamente.
      warn(`parse-pool: worker morreu (${why}) durante ${task.op}; resolvendo com default seguro.`);
      settle(task, task.safeDefault);
    }
    pump();
  };
  worker.on('error', (e) => onDeath(e?.message || 'error'));
  worker.on('exit', (code) => {
    if (code !== 0) onDeath(`exit ${code}`);
  });

  state.workers.push(rec);
  return rec;
}

// Entrega tasks da fila a workers ociosos; sobe workers até PARSE_WORKERS enquanto houver fila.
function pump() {
  for (const rec of state.workers) {
    if (!state.queue.length) return;
    if (rec.task) continue;
    assign(rec, state.queue.shift());
  }
  while (state.queue.length && state.workers.length < PARSE_WORKERS) {
    const rec = spawn();
    if (!rec) {
      // Não subiu: com ZERO workers vivos, a fila não tem quem a atenda — e task na FILA não
      // tem timer (só ganha em assign). Sem drenar aqui, runParse penduraria p/ sempre.
      // Fail-open: roda inline (com workers vivos, deixa na fila — eles drenam ao terminar).
      if (state.disabled || state.workers.length === 0) {
        for (const t of state.queue.splice(0)) settle(t, runInline(t.op, t.args, t.safeDefault));
      }
      return;
    }
    assign(rec, state.queue.shift());
  }
}

function assign(rec, task) {
  rec.task = task;
  rec.worker.ref(); // ocupado segura o event loop (a resposta do parse é trabalho pendente real)
  task.timer = setTimeout(() => {
    // Task travada: mata o worker (pode estar num loop nativo), respawna e resolve com o default.
    warn(`parse-pool: timeout (${PARSE_TIMEOUT_MS}ms) em ${task.op}; reciclando worker.`);
    rec.task = null;
    removeWorker(rec);
    settle(task, task.safeDefault);
    pump();
  }, PARSE_TIMEOUT_MS);
  task.timer.unref?.();
  rec.worker.postMessage({ id: task.id, op: task.op, args: task.args });
}

/**
 * Roda uma op de parse (extractArticle | readableLinks | probablyArticle) num worker, resolvendo
 * SEMPRE (nunca rejeita): em crash/timeout/erro devolve `safeDefault`. Com o pool desligado ou
 * indisponível, roda inline no processo principal.
 */
export function runParse(op, args, safeDefault) {
  if (state.disabled) return Promise.resolve(runInline(op, args, safeDefault));
  return new Promise((resolve) => {
    state.queue.push({ id: ++state.seq, op, args, safeDefault, resolve, timer: null, _done: false });
    pump();
  });
}

/** Encerra o pool (chamado ao fim do crawl, junto do closeBrowser). Idempotente. */
export async function closeParsePool() {
  const recs = state.workers.splice(0);
  await Promise.all(
    recs.map((rec) => {
      rec.worker.removeAllListeners();
      return rec.worker.terminate().catch(() => {});
    }),
  );
}

/** Telemetria p/ teste/inspeção. */
export function parsePoolState() {
  return { disabled: state.disabled, workers: state.workers.length, queued: state.queue.length };
}
