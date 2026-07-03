// Fluxo de EVENTOS ao vivo da run (os MARCOS) para o painel da TUI — separado do progresso
// (contadores, progress.js) e do log cru (setLogSink). Um emissor estruturado: o orquestrador e o
// crawl chamam emitRunEvent() nos poucos marcos que importam (início/fim de fase, fonte concluída,
// coletânea curada, item mantido com resumo, timeout, erro); o "salvo" de cada artigo vai pro canal
// 'ticker' (atualiza UMA linha no lugar, não polui o feed rolável). Preferido a classificar strings
// do log() — marcos e plumbing são ambos level:'log', então separá-los por regex de português seria
// frágil. Módulo PURO (sem imports): qualquer camada emite sem risco de ciclo; sem assinante (CLI)
// é um no-op barato. Ring limitado + coalescing de rajadas idênticas. runEventsReset() zera entre
// runs (o ring é global ao processo, como o rastreador de progresso).
const CAP = 100; // máximo de marcos retidos (a UI mostra ~10; o resto é histórico p/ o overlay)
const COALESCE_MS = 1200; // rajada do MESMO marco dentro desta janela vira "(×N)"

let ring = [];
let ticker = null; // último evento de canal 'ticker' (ex.: "salvo: <título>")
let warnCount = 0; // avisos internos (plumbing) contados, NÃO despejados no feed
let seq = 0;
const subs = new Set();

function snap() {
  return { feed: ring, ticker, warnCount, seq };
}
function notify() {
  for (const fn of subs) {
    try {
      fn(snap());
    } catch {
      /* um assinante quebrado nunca derruba o emissor */
    }
  }
}

/** Zera o estado no início de cada crawl — o ring é global ao processo e não pode vazar entre runs. */
export function runEventsReset() {
  ring = [];
  ticker = null;
  warnCount = 0;
  seq = 0;
  notify();
}

/**
 * Emite um marco. `channel:'feed'` (default) entra no ring rolável; `channel:'ticker'` substitui a
 * linha "último salvo". Campos: { phase, kind, source?, detail?, level?='info', channel? }. Rajadas
 * idênticas (mesmo kind/phase/source/detail dentro de COALESCE_MS) são coalescidas em `count`.
 */
export function emitRunEvent(ev) {
  const e = { id: ++seq, at: Date.now(), level: 'info', phase: 'run', channel: 'feed', ...ev };
  if (e.channel === 'ticker') {
    ticker = e;
  } else {
    const last = ring[ring.length - 1];
    if (
      last &&
      last.kind === e.kind &&
      last.phase === e.phase &&
      last.source === e.source &&
      last.detail === e.detail &&
      e.at - last.at < COALESCE_MS
    ) {
      last.count = (last.count || 1) + 1;
      last.at = e.at;
    } else {
      ring.push(e);
      if (ring.length > CAP) ring.shift();
    }
  }
  notify();
}

/** Conta um aviso interno (plumbing) sem despejá-lo no feed — o rodapé mostra só o total. */
export function bumpWarnCount(n = 1) {
  warnCount += n;
  notify();
}

/** Assina o fluxo; dispara JÁ com o snapshot atual e devolve o unsubscribe. */
export function subscribeRunEvents(fn) {
  subs.add(fn);
  try {
    fn(snap());
  } catch {
    /* idem */
  }
  return () => subs.delete(fn);
}
