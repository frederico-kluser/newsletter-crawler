// Checkpoint da busca EM ANDAMENTO do webapp estático (localStorage via storage.js). Diferente do
// history.js (que só grava buscas CONCLUÍDAS), este é um SLOT ÚNICO de "troca rápida": sobrescrito
// com throttle enquanto a busca roda e LIMPO a cada nova busca / conclusão / cancelamento ATIVO.
// Serve para RETOMAR de onde parou após um reload (ou fechar-e-reabrir a aba) — guarda os ids já
// julgados (p/ pular sem repagar) + os hits achados + contadores + custo. Payload versionado {v:1}.
import { clearActive, getActiveRaw, trySetActive } from './storage.js';

const VERSION = 1;

/** Lê e valida o checkpoint; qualquer corrupção/versão diferente/sem query vira null (fail-open). */
export function loadActiveSearch() {
  const raw = getActiveRaw();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== VERSION || !parsed.query) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Grava (sobrescreve) o checkpoint. Fail-open: quota cheia/erro → false, nunca lança. */
export function saveActiveSearch(payload) {
  try {
    return trySetActive(JSON.stringify({ v: VERSION, ...payload }));
  } catch {
    return false;
  }
}

/** Remove o checkpoint (nova busca / conclusão / cancelamento ativo). */
export function clearActiveSearch() {
  clearActive();
}

/**
 * Writer com THROTTLE de borda-de-ataque (SEM timer; `now` injetável p/ teste, estilo lane.js):
 * a 1ª escrita sai na hora; as seguintes dentro de `minMs` só guardam o valor MAIS NOVO, gravado
 * no próximo push fora da janela ou num flush() explícito (chamado no fim e no pagehide). Recebe um
 * `build` (thunk) só materializado QUANDO grava — evita montar arrays grandes de ids a cada item.
 */
export function makeCheckpointWriter({ minMs = 1200, now = () => Date.now(), write } = {}) {
  let lastAt = -Infinity;
  let pending = null;
  const emit = () => {
    lastAt = now();
    const build = pending;
    pending = null;
    write(build());
  };
  return {
    push(build) {
      pending = build;
      if (now() - lastAt >= minMs) emit();
    },
    flush() {
      if (pending) emit();
    },
    cancel() {
      pending = null;
    },
  };
}
