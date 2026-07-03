// Concorrência ADAPTATIVA (AIMD) para as buscas de IA no browser — porta do governor do CLI
// (src/governor.js:314-321,201-210). A lane começa no TETO e CORTA PELA METADE a cada 429
// (piso mínimo), RECUPERANDO +1 a cada janela de 10s sem 429. openrouter.js chama
// noteRateLimit() de dentro de bumpPenalty (igual llm.js:64 → reportRateLimit()), e a
// adaptivePool relê currentLimit() a cada aquisição — a largura efetiva do pool acompanha a
// lane SEM preempção (encolher não mata quem já está em voo; crescer só admite novos workers).
//
// Estado módulo-level: só UMA busca roda por vez (o hook aborta a anterior), então uma lane
// global basta. `now` é injetável p/ o teste dirigir o tempo sem depender do relógio real.
const GROW_INTERVAL_MS = 10_000;

let _ceil = 6;
let _floor = 2;
let _limit = 6;
let _lastRateLimitAt = 0;
let _lastGrowAt = 0;

/** (Re)configura a lane no início de uma busca: teto/piso do modo; começa OTIMISTA (no teto). */
export function configureLane({ ceil, floor } = {}) {
  _ceil = Math.max(1, Math.floor(ceil) || _ceil);
  _floor = Math.max(1, Math.min(Math.floor(floor) || _floor, _ceil));
  _limit = _ceil;
  _lastRateLimitAt = 0;
  _lastGrowAt = 0;
}

/** 429 do provedor: corta a lane pela metade (piso _floor). Chamada por openrouter.bumpPenalty. */
export function noteRateLimit(now = Date.now()) {
  _limit = Math.max(_floor, Math.ceil(_limit / 2));
  _lastRateLimitAt = now;
}

/** Largura atual: recupera +1 por janela limpa de 10s (até o teto) e devolve o valor vigente. */
export function currentLimit(now = Date.now()) {
  if (
    _limit < _ceil &&
    now - _lastRateLimitAt >= GROW_INTERVAL_MS &&
    now - _lastGrowAt >= GROW_INTERVAL_MS
  ) {
    _limit += 1;
    _lastGrowAt = now;
  }
  return _limit;
}

/** Snapshot p/ teste/inspeção (não usar p/ decisão de concorrência — use currentLimit). */
export function laneState() {
  return { ceil: _ceil, floor: _floor, limit: _limit };
}
