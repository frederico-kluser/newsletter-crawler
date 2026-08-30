// Governador de recursos: divide o teto global (--parallel) em "lanes" (llm/fetch/render/cpu)
// e adapta as capacidades em tempo real pela RAM DO SISTEMA (MemAvailable), via AIMD com
// histerese. As lanes são instâncias p-limit redimensionadas AO VIVO (limit.concurrency = n):
// grow acorda a fila na hora; shrink é NÃO-preemptivo (trabalho em voo termina; só novas
// admissões esperam) — semântica pinada em test/governor.gate.test.js.
// A lane llm tem AIMD PRÓPRIO, calibrado por falhas de API: 429 halva a lane E o TETO
// (st.llmCap) — a recuperação +1/10s só sobe até o teto calibrado, então a lane CONVERGE no
// nível sem 429 em vez de oscilar. O teto calibrado parte de GOVERNOR_LLM_CAP (persistido
// pelo fim de run em NC_HOME/.env) e é re-persistido quando a calibração baixa mais.
// Sem init explícito, as lanes ficam em defaults conservadores (≈ o comportamento antigo),
// então eval/ e testes podem importar llm.js sem subir o laço.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import pLimit from 'p-limit';
import {
  MAX_PARALLEL, RAM_MAX_PCT, RAM_HYSTERESIS_PCT, GOVERNOR_TICK_MS, RENDER_EST_MB, GOVERNOR_LLM_CAP,
} from './config.js';
import { debug, warn } from './util.js';

const GIB = 1024 ** 3;
// Pisos incondicionais (garantia de progresso): nenhuma lane chega a 0. llm=3 dá folga p/ o
// fan-out por seção (curadoria) + o streaming de verify/summarize/classify nas máquinas menores.
const FLOORS = { llm: 3, fetch: 1, render: 1, cpu: 1 };
// A lane cpu limita parses SÍNCRONOS (JSDOM/Readability/prune) — o teto é fixo e baixo de
// propósito: 32 núcleos não ajudam num event loop só; o que importa é o débito de latência.
const CPU_CAP = 2;

/** Extrai MemTotal/MemAvailable (kB -> bytes) do texto de /proc/meminfo. null se faltar. */
export function parseMemInfo(text) {
  const kb = (re) => {
    const m = String(text || '').match(re);
    return m ? Number(m[1]) * 1024 : null;
  };
  const totalBytes = kb(/^MemTotal:\s*(\d+)\s*kB/m);
  const availableBytes = kb(/^MemAvailable:\s*(\d+)\s*kB/m);
  return totalBytes && availableBytes != null ? { totalBytes, availableBytes } : null;
}

/** Leitura da RAM do sistema: /proc/meminfo (MemAvailable conta cache recuperável — o sinal
 * certo) -> process.availableMemory() (respeita cgroups) -> os.freemem() (sub-reporta). */
export function readMemInfo() {
  try {
    const parsed = parseMemInfo(readFileSync('/proc/meminfo', 'utf8'));
    if (parsed) return parsed;
  } catch {
    /* não-Linux: cai nos fallbacks */
  }
  const totalBytes = os.totalmem();
  try {
    if (typeof process.availableMemory === 'function') {
      const a = process.availableMemory();
      if (Number.isFinite(a) && a > 0) return { totalBytes, availableBytes: a };
    }
  } catch {
    /* segue p/ freemem */
  }
  return { totalBytes, availableBytes: os.freemem() };
}

// Lanes singleton: os módulos pegam a referência via getLane() a cada uso; init/setProfile
// só REDIMENSIONAM (nunca recriam), então referências antigas continuam válidas.
const lanes = {
  llm: pLimit(6),
  fetch: pLimit(3),
  render: pLimit(2),
  cpu: pLimit(CPU_CAP),
};

const st = {
  running: false,
  timer: null,
  parallel: MAX_PARALLEL,
  profile: 'llm-only',
  alloc: { llm: 6, fetch: 3, render: 2 }, // tetos por lane do perfil ativo
  ramMaxPct: RAM_MAX_PCT,
  hysteresisPct: RAM_HYSTERESIS_PCT,
  renderEstBytes: RENDER_EST_MB * 1024 * 1024,
  tickMs: GOVERNOR_TICK_MS,
  brakeBytes: 1.5 * GIB,
  readMem: readMemInfo,
  now: Date.now,
  onEmergencyBrake: null,
  totalBytes: 0,
  lastAvail: 0,
  emaAvail: null,
  floorBytes: 0,
  ramState: 'ok', // ok | hold | pressure | critical
  overTicks: 0,
  goodTicks: 0,
  calmTicks: 0,
  lastShrinkAt: 0,
  brakeSince: 0,
  lastRateLimitAt: 0,
  llmGrowAt: 0,
  expectedAt: 0,
  lagMs: 0,
  // Teto CALIBRADO da lane llm (0 = ainda não calibrado; vale o teto do perfil). Só desce:
  // reportRateLimit() o baixa junto com a lane; o grow +1/10s não passa dele.
  llmCap: 0,
  rateLimitEvents: 0,
};

function safeRead() {
  try {
    return st.readMem();
  } catch {
    return null;
  }
}

function computeAlloc(profile, n, ramRenderCap) {
  if (profile === 'crawl') {
    // llm = n (a máquina INTEIRA na lane de API): fetch/render são lanes SEPARADAS (rede/RAM),
    // então 1.0+0.25+0.25 = 1.5n operações I/O-bound cabe num event loop de n núcleos sem
    // roubar nada. O teto de API é quem manda no llm — e é EXATAMENTE o que a calibração por
    // 429 encontra (reportRateLimit baixa st.llmCap; o grow +1/10s não passa do calibrado).
    // Salvaguardas de custo intactas (orçamento + penalty window compartilhada).
    return {
      llm: Math.max(FLOORS.llm, n),
      fetch: Math.max(FLOORS.fetch, Math.ceil(n * 0.25)),
      render: Math.max(FLOORS.render, Math.min(Math.ceil(n * 0.25), ramRenderCap)),
    };
  }
  // llm-only (classify/summarize/search e pós-crawl): todo o teto vai p/ a lane llm;
  // fetch/render ficam no piso (não são usados nesses estágios).
  return { llm: Math.max(FLOORS.llm, n), fetch: FLOORS.fetch, render: FLOORS.render };
}

function applyProfile() {
  const avail = st.emaAvail ?? st.totalBytes;
  const usable = Math.max(0, avail - st.floorBytes);
  const ramRenderCap = Math.max(1, Math.min(Math.floor((usable * 0.5) / st.renderEstBytes) || 1, 64));
  st.alloc = computeAlloc(st.profile, st.parallel, ramRenderCap);
  // O teto calibrado da lane llm sobrevive ao perfil (crawl -> llm-only) e é re-clampado ao
  // teto do perfil atual: nunca sobe sozinho acima do que a API suportou.
  st.llmCap = st.llmCap > 0 ? Math.max(FLOORS.llm, Math.min(st.llmCap, st.alloc.llm)) : st.alloc.llm;
  lanes.llm.concurrency = st.llmCap;
  lanes.fetch.concurrency = st.alloc.fetch;
  // Slew de partida: render começa pequeno e o AIMD cresce +1/tick com folga de RAM — evita
  // admitir N contextos Chromium de uma vez antes da 1ª amostra sentir o impacto deles.
  lanes.render.concurrency = Math.min(2, st.alloc.render);
  lanes.cpu.concurrency = CPU_CAP;
}

function shrinkLane(name, to, now) {
  if (lanes[name].concurrency > to) {
    debug(`governor: shrink ${name} ${lanes[name].concurrency} -> ${to}`);
    lanes[name].concurrency = to;
    st.lastShrinkAt = now;
  }
}

/** Um passo do controlador. Exportado p/ os testes dirigirem com readMem/now roteirizados. */
export function governorTick(now = st.now()) {
  const mem = safeRead();
  if (!mem) return; // sem sinal de RAM: mantém a divisão estática do perfil
  st.totalBytes = mem.totalBytes || st.totalBytes;
  st.lastAvail = mem.availableBytes;
  st.emaAvail = st.emaAvail == null ? mem.availableBytes : 0.5 * st.emaAvail + 0.5 * mem.availableBytes;

  const growCut = st.floorBytes + st.totalBytes * (st.hysteresisPct / 100);

  if (mem.availableBytes < st.brakeBytes) {
    // Freio de emergência (RAM crua, sem EMA — urgência não espera suavização): render vai
    // ao piso já; persistindo 30s, recicla o browser via callback injetado (sem ciclo
    // governor<->fetch). Nunca cancela render em voo — só corta admissões novas.
    st.ramState = 'critical';
    shrinkLane('render', FLOORS.render, now);
    if (!st.brakeSince) st.brakeSince = now;
    else if (now - st.brakeSince >= 30_000) {
      st.brakeSince = now; // re-arma p/ reciclar de novo se seguir crítico
      if (st.onEmergencyBrake) {
        warn('governor: RAM crítica há 30s — reciclando o browser');
        st.onEmergencyBrake();
      }
    }
    st.overTicks += 1;
    st.goodTicks = 0;
  } else if (st.emaAvail < st.floorBytes) {
    st.ramState = 'pressure';
    st.brakeSince = 0;
    st.overTicks += 1;
    st.goodTicks = 0;
    // Uma ação por tick: render primeiro (o vilão de RAM); fetch só sob pressão sustentada.
    if (lanes.render.concurrency > FLOORS.render) {
      shrinkLane('render', Math.max(FLOORS.render, Math.floor(lanes.render.concurrency / 2)), now);
    } else if (st.overTicks >= 5 && lanes.fetch.concurrency > FLOORS.fetch) {
      shrinkLane('fetch', Math.max(FLOORS.fetch, Math.floor(lanes.fetch.concurrency / 2)), now);
    }
  } else if (st.emaAvail < growCut) {
    st.ramState = 'hold';
    st.brakeSince = 0;
    st.overTicks = 0;
    st.goodTicks = 0;
  } else {
    st.ramState = 'ok';
    st.brakeSince = 0;
    st.overTicks = 0;
    st.goodTicks += 1;
    if (st.goodTicks >= 3 && now - st.lastShrinkAt >= 10_000 && st.lagMs <= 250) {
      // Aditivo: +1 em UMA lane por tick — fetch primeiro (barato); render por último e só
      // com folga p/ >= 2 renders acima do piso (a "reserva" de RENDER_EST_MB por admissão).
      if (lanes.fetch.concurrency < st.alloc.fetch) {
        lanes.fetch.concurrency += 1;
      } else if (
        lanes.render.concurrency < st.alloc.render &&
        st.emaAvail - st.floorBytes > 2 * st.renderEstBytes
      ) {
        lanes.render.concurrency += 1;
      }
    }
  }

  // Lane llm é independente da RAM: só recua com 429 (reportRateLimit) e recupera +1 por
  // janela limpa de 10s — mas NUNCA acima do TETO CALIBRADO (st.llmCap): é o limite aprendido
  // por falhas de API, a convergência do AIMD em vez da oscilação.
  if (
    lanes.llm.concurrency < st.llmCap &&
    now - st.lastRateLimitAt >= 10_000 &&
    now - st.llmGrowAt >= 10_000
  ) {
    lanes.llm.concurrency += 1;
    st.llmGrowAt = now;
  }

  // Lane cpu: lag alto no tick = event loop atolado em parses síncronos -> encolhe; volta
  // ao teto depois de 5 ticks calmos.
  if (st.lagMs > 1000 && lanes.cpu.concurrency > FLOORS.cpu) {
    lanes.cpu.concurrency = FLOORS.cpu;
    st.calmTicks = 0;
  } else if (st.lagMs <= 250) {
    st.calmTicks += 1;
    if (st.calmTicks >= 5 && lanes.cpu.concurrency < CPU_CAP) lanes.cpu.concurrency = CPU_CAP;
  } else {
    st.calmTicks = 0;
  }
}

function startLoop() {
  st.running = true;
  st.expectedAt = st.now() + st.tickMs;
  const loop = () => {
    if (!st.running) return;
    const now = st.now();
    st.lagMs = Math.max(0, now - st.expectedAt);
    governorTick(now);
    st.expectedAt = st.now() + st.tickMs;
    st.timer = setTimeout(loop, st.tickMs);
    st.timer.unref?.();
  };
  st.timer = setTimeout(loop, st.tickMs);
  st.timer.unref?.();
}

/**
 * (Re)configura as lanes e liga o laço AIMD. Re-init é seguro (a TUI roda vários comandos no
 * mesmo processo). Opções injetáveis p/ teste: readMem, now, tickMs, autoStart:false (dirigir
 * com governorTick), ramMaxPct, ramHysteresisPct, renderEstMb, brakeBytes, onEmergencyBrake,
 * llmCap (teto calibrado inicial; default = GOVERNOR_LLM_CAP do env / NC_HOME .env).
 */
export function initGovernor(opts = {}) {
  stopGovernor();
  const p = Number(opts.parallel);
  st.parallel = Number.isFinite(p) && p >= 1 ? Math.floor(p) : MAX_PARALLEL;
  st.profile = opts.profile || 'llm-only';
  st.readMem = opts.readMem || readMemInfo;
  st.now = opts.now || Date.now;
  st.tickMs = opts.tickMs ?? GOVERNOR_TICK_MS;
  st.ramMaxPct = opts.ramMaxPct ?? RAM_MAX_PCT;
  st.hysteresisPct = opts.ramHysteresisPct ?? RAM_HYSTERESIS_PCT;
  st.renderEstBytes = (opts.renderEstMb ?? RENDER_EST_MB) * 1024 * 1024;
  st.brakeBytes = opts.brakeBytes ?? 1.5 * GIB;
  st.onEmergencyBrake = opts.onEmergencyBrake || null;

  const mem = safeRead();
  st.totalBytes = mem?.totalBytes || os.totalmem();
  st.lastAvail = mem?.availableBytes ?? 0;
  st.emaAvail = mem ? mem.availableBytes : null;
  st.floorBytes = Math.max(st.totalBytes * (1 - st.ramMaxPct / 100), 2 * GIB);
  st.ramState = 'ok';
  st.overTicks = 0;
  st.goodTicks = 0;
  st.calmTicks = 0;
  st.lastShrinkAt = 0;
  st.brakeSince = 0;
  st.lastRateLimitAt = 0;
  st.llmGrowAt = 0;
  st.lagMs = 0;
  st.rateLimitEvents = 0;
  // Teto calibrado inicial: cap persistido (env/NC_HOME) ou teto do perfil; applyProfile clampa.
  const cap = opts.llmCap != null ? Number(opts.llmCap) : GOVERNOR_LLM_CAP;
  st.llmCap = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;

  applyProfile();
  debug(
    `governor: init parallel=${st.parallel} profile=${st.profile} ` +
      `lanes llm=${lanes.llm.concurrency} fetch=${lanes.fetch.concurrency} render=${lanes.render.concurrency} ` +
      `(alloc render=${st.alloc.render}) floor=${(st.floorBytes / GIB).toFixed(1)}GiB` +
      (GOVERNOR_LLM_CAP > 0 ? ` cap calibrado llm=${GOVERNOR_LLM_CAP}` : ''),
  );
  if (opts.autoStart !== false) startLoop();
  return getTelemetry();
}

/** Troca o perfil sem reiniciar (ex.: crawl -> llm-only nos hooks pós-crawl). */
export function setProfile(profile) {
  st.profile = profile;
  applyProfile();
}

export function stopGovernor() {
  st.running = false;
  if (st.timer) {
    clearTimeout(st.timer);
    st.timer = null;
  }
}

export function getLane(name) {
  return lanes[name];
}

/** Capacidade do loop de jobs do crawl (1 job segura no máx. 1 fetch OU 1 render por vez). */
export function jobsCapacity() {
  return lanes.fetch.concurrency + lanes.render.concurrency;
}

/** Janela de um estágio: min(override de env se > 0, capacidade atual da lane llm). */
export function stageWindow(override) {
  return Math.max(1, Math.min(override > 0 ? override : Infinity, lanes.llm.concurrency));
}

/**
 * Backpressure de 429 do provedor: multiplicativo na lane llm E no TETO CALIBRADO (st.llmCap).
 * A lane halva na hora (recupera +1/10s no tick); o teto desce junto e NÃO sobe mais nesta
 * run — é a "calibração de um valor limite": converge no nível sem 429 e é persistido no
 * fim do run (GOVERNOR_LLM_CAP) p/ os próximos partirem dele.
 */
export function reportRateLimit() {
  st.lastRateLimitAt = st.now();
  st.rateLimitEvents += 1;
  const to = Math.max(FLOORS.llm, Math.ceil(lanes.llm.concurrency / 2));
  if (to < lanes.llm.concurrency) {
    warn(`governor: 429 do provedor — lane llm ${lanes.llm.concurrency} -> ${to}`);
    lanes.llm.concurrency = to;
  }
  if (to < st.llmCap) {
    warn(`governor: calibrando teto llm para ${to} (${st.rateLimitEvents}º 429; limite ${st.llmCap} -> ${to})`);
    st.llmCap = to;
  }
}

/** Calibração corrente da lane llm p/ persistir no fim do run (dirty = teto < teto do perfil). */
export function getCalibration() {
  return {
    llmCap: st.llmCap,
    rateLimitEvents: st.rateLimitEvents,
    dirty: st.llmCap > 0 && st.llmCap < st.alloc.llm,
  };
}

export function getTelemetry() {
  const laneInfo = (l) => ({ capacity: l.concurrency, active: l.activeCount, queued: l.pendingCount });
  const usedPct = st.totalBytes
    ? Math.round(((st.totalBytes - (st.lastAvail || st.totalBytes)) / st.totalBytes) * 100)
    : 0;
  return {
    ram: {
      totalBytes: st.totalBytes,
      availableBytes: st.lastAvail,
      usedPct,
      maxPct: st.ramMaxPct,
      state: st.ramState,
    },
    parallel: { max: st.parallel, profile: st.profile },
    lanes: {
      llm: laneInfo(lanes.llm),
      fetch: laneInfo(lanes.fetch),
      render: laneInfo(lanes.render),
      cpu: laneInfo(lanes.cpu),
      jobs: { capacity: jobsCapacity() },
    },
    calib: { llmCap: st.llmCap, rateLimitEvents: st.rateLimitEvents },
  };
}
