// Pool de PROCESSOS de parsing (child_process/fork). Isola o JSDOM em processos SEPARADOS: um
// SIGSEGV nativo do parser de CSS do JSDOM mata SÓ o processo-filho; o pool vê o 'exit' (com
// signal) e respawna, resolvendo a task em voo com um DEFAULT SEGURO (o chamador degrada — usa
// content-selector/LLM ou mantém o blurb). NÃO re-executa a task que crashou inline (isso
// arriscaria derrubar o processo principal).
//
// [POR QUE PROCESSO, NÃO THREAD] Antes isto usava worker_threads — que compartilham o MESMO
// processo: um SIGSEGV NATIVO (sinal de hardware) derrubava TUDO ("core dumped"), respawn nenhum.
// O Node só intercepta process.exit()/throw dentro de um worker, NÃO um segfault. Só um processo
// separado (fork) isola sinais nativos — comprovado: worker+SIGSEGV mata o pai; child+SIGSEGV não.
//
// Tamanho PARSE_WORKERS; timeout por task PARSE_TIMEOUT_MS; timeout de startup do filho
// PARSE_READY_TIMEOUT_MS. Sem conseguir subir filhos (fork falha, arquivo ausente, protocolo
// inválido, ou PARSE_IN_WORKERS=false), roda INLINE no processo principal. Filhos ociosos são
// unref'd (não seguram o processo vivo); um filho ocupado, ou um começando (readyTimer), é ref'd.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from './parse-core.js';
import { PARSE_WORKERS, PARSE_TIMEOUT_MS, PARSE_IN_WORKERS, PARSE_READY_TIMEOUT_MS } from './config.js';
import { warn, debug } from './util.js';

const MAX_SPAWN_FAILS = 3; // após isso, desiste do pool e vai 100% inline

// Caminho do módulo do filho (env PARSE_WORKER_PATH troca p/ um fixture nos testes). Resolvido
// como CAMINHO de arquivo: fileURLToPath LANÇA p/ protocolo != file: (ex.: uma URL http),
// preservando a semântica de "falha SÍNCRONA de spawn" do antigo ctor Worker.
function resolveWorkerPath() {
  const u = process.env.PARSE_WORKER_PATH
    ? new URL(process.env.PARSE_WORKER_PATH, import.meta.url)
    : new URL('./parse-worker.js', import.meta.url);
  return fileURLToPath(u);
}

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
  workers: [], // { child, task, ready, readyTimer }
  queue: [], // tasks aguardando um worker: { id, op, args, safeDefault, resolve, timer, _done }
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
  if (rec.readyTimer) clearTimeout(rec.readyTimer);
  rec.child.removeAllListeners();
  try {
    rec.child.kill('SIGKILL');
  } catch {
    /* já morto */
  }
}

function onSpawnFail(why) {
  state.spawnFails++;
  warn(`parse-pool: falha ao subir worker (${why}); ${state.spawnFails}/${MAX_SPAWN_FAILS}`);
  if (state.spawnFails >= MAX_SPAWN_FAILS) {
    state.disabled = true;
    warn('parse-pool: desativado — parsing seguirá INLINE no processo principal.');
  }
}

function spawn() {
  let child;
  try {
    child = fork(resolveWorkerPath(), [], {
      // Silencia o filho (inclusive o dump de stack NATIVO que o V8 imprime ao crashar) — o único
      // canal é o IPC. O crash já é reportado limpo via warn 'worker morreu'.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced', // structured-clone (paridade com o worker_threads antigo)
    });
  } catch (e) {
    // fork SÍNCRONO falhou (protocolo inválido via fileURLToPath, EMFILE, etc.): falha de spawn.
    onSpawnFail(e.message);
    return null;
  }
  child.unref(); // ocioso não segura o processo; assign() faz ref() enquanto há task
  child.channel?.unref?.();
  const rec = { child, task: null, ready: false, readyTimer: null };

  // Handshake: o filho manda {ready:true} quando os módulos carregaram. Só então recebe tasks. O
  // readyTimer fica REF'D de propósito: enquanto um parse aguarda um filho subir, o processo NÃO
  // pode esvaziar o event loop e sair no meio (o child ocioso está unref'd). Some ao virar ready.
  rec.readyTimer = setTimeout(() => {
    if (rec.ready) return;
    warn(`parse-pool: worker não ficou pronto em ${PARSE_READY_TIMEOUT_MS}ms; descartando.`);
    removeWorker(rec);
    onSpawnFail('ready timeout');
    pump();
  }, PARSE_READY_TIMEOUT_MS);

  child.on('message', (msg) => {
    if (msg && msg.ready) {
      rec.ready = true;
      if (rec.readyTimer) {
        clearTimeout(rec.readyTimer);
        rec.readyTimer = null;
      }
      state.spawnFails = 0; // um filho saudável zera a sequência de falhas
      pump();
      return;
    }
    const task = rec.task;
    if (!task || task.id !== msg?.id) return; // mensagem órfã (task já resolvida por timeout)
    rec.task = null;
    child.unref(); // volta a não segurar o loop (idem worker_threads antigo)
    child.channel?.unref?.();
    if (!msg.ok) debug(`parse (${task.op}) erro no worker: ${msg.error}`);
    settle(task, msg.ok ? msg.result : task.safeDefault);
    pump();
  });

  const onDeath = (why) => {
    const wasReady = rec.ready;
    const task = rec.task;
    rec.task = null;
    removeWorker(rec);
    if (task) {
      // Crash DURANTE a task (ex.: SIGSEGV do JSDOM): NÃO re-executa inline (arriscaria o main).
      // Resolve com o default seguro — o chamador degrada graciosamente.
      warn(`parse-pool: worker morreu (${why}) durante ${task.op}; resolvendo com default seguro.`);
      settle(task, task.safeDefault);
    } else if (!wasReady) {
      // Morreu no startup sem nunca ficar pronto (arquivo ausente etc.): conta como falha de spawn.
      onSpawnFail(why);
    }
    pump();
  };
  child.on('error', (e) => onDeath(e?.message || 'error'));
  child.on('exit', (code, signal) => {
    if (signal || code !== 0) onDeath(signal ? `signal ${signal}` : `exit ${code}`);
  });

  state.workers.push(rec);
  return rec;
}

// Entrega tasks a filhos PRONTOS e ociosos; sobe novos filhos (só o necessário) até PARSE_WORKERS.
function pump() {
  for (const rec of state.workers) {
    if (!state.queue.length) return;
    if (rec.task || !rec.ready) continue;
    assign(rec, state.queue.shift());
  }
  while (state.queue.length && !state.disabled && state.workers.length < PARSE_WORKERS) {
    // filhos que logo poderão atender: prontos-ociosos + os que estão subindo (ainda não ready).
    const coming = state.workers.filter((r) => !r.ready || !r.task).length;
    if (coming >= state.queue.length) break; // já há capacidade a caminho p/ toda a fila
    if (!spawn()) break; // falha SÍNCRONA de spawn: cai no drain inline abaixo
  }
  // Fail-open anti-hang: há fila mas NINGUÉM p/ atendê-la (nem vivo, nem a caminho) — e task na
  // FILA não tem timer (só ganha em assign). Sem drenar aqui, runParse penduraria p/ sempre.
  if (state.queue.length && (state.disabled || state.workers.length === 0)) {
    for (const t of state.queue.splice(0)) settle(t, runInline(t.op, t.args, t.safeDefault));
  }
}

function assign(rec, task) {
  rec.task = task;
  rec.child.ref(); // ocupado segura o event loop (a resposta do parse é trabalho pendente real)
  rec.child.channel?.ref?.();
  task.timer = setTimeout(() => {
    // Task travada: mata o filho (pode estar num loop nativo), respawna e resolve com o default.
    warn(`parse-pool: timeout (${PARSE_TIMEOUT_MS}ms) em ${task.op}; reciclando worker.`);
    rec.task = null;
    removeWorker(rec);
    settle(task, task.safeDefault);
    pump();
  }, PARSE_TIMEOUT_MS);
  task.timer.unref?.();
  try {
    rec.child.send({ id: task.id, op: task.op, args: task.args });
  } catch {
    // Canal fechado na janela (filho morreu antes do send): trata como morte, resolve e segue.
    if (task.timer) clearTimeout(task.timer);
    rec.task = null;
    removeWorker(rec);
    settle(task, task.safeDefault);
    pump();
  }
}

/**
 * Roda uma op de parse (extractArticle | readableLinks | probablyArticle) num PROCESSO-filho,
 * resolvendo SEMPRE (nunca rejeita): em crash/timeout/erro devolve `safeDefault`. Com o pool
 * desligado ou indisponível, roda inline no processo principal.
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
  for (const rec of recs) {
    if (rec.readyTimer) clearTimeout(rec.readyTimer);
    rec.child.removeAllListeners();
    try {
      rec.child.kill('SIGKILL');
    } catch {
      /* já morto */
    }
  }
}

/** Telemetria p/ teste/inspeção. */
export function parsePoolState() {
  return { disabled: state.disabled, workers: state.workers.length, queued: state.queue.length };
}
