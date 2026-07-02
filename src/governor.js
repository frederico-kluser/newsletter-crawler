// Governador de recursos: divide o teto global (--parallel) em "lanes" (llm/fetch/render/cpu)
// e adapta as capacidades em tempo real pela RAM DO SISTEMA (MemAvailable), via AIMD com
// histerese. As lanes são instâncias p-limit redimensionadas AO VIVO (limit.concurrency = n):
// grow acorda a fila na hora; shrink é NÃO-preemptivo (trabalho em voo termina; só novas
// admissões esperam) — semântica pinada em test/governor.gate.test.js.
// Sem init explícito, as lanes ficam em defaults conservadores (≈ o comportamento antigo),
// então eval/ e testes podem importar llm.js sem subir o laço.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import pLimit from 'p-limit';
import {
  MAX_PARALLEL, RAM_MAX_PCT, RAM_HYSTERESIS_PCT, GOVERNOR_TICK_MS, RENDER_EST_MB,
} from './config.js';
import { debug, warn } from './util.js';

const GIB = 1024 ** 3;
// Pisos incondicionais (garantia de progresso): nenhuma lane chega a 0.
const FLOORS = { llm: 2, fetch: 1, render: 1, cpu: 1 };
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
    return {
      llm: Math.max(FLOORS.llm, Math.ceil(n * 0.5)),
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
  lanes.llm.concurrency = st.alloc.llm;
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
  // janela limpa de 10s até o teto do perfil.
  if (
    lanes.llm.concurrency < st.alloc.llm &&
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
 * com governorTick), ramMaxPct, ramHysteresisPct, renderEstMb, brakeBytes, onEmergencyBrake.
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

  applyProfile();
  debug(
    `governor: init parallel=${st.parallel} profile=${st.profile} ` +
      `lanes llm=${lanes.llm.concurrency} fetch=${lanes.fetch.concurrency} render=${lanes.render.concurrency} ` +
      `(alloc render=${st.alloc.render}) floor=${(st.floorBytes / GIB).toFixed(1)}GiB`,
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

/** Backpressure de 429 do provedor: multiplicativo na lane llm (recupera +1/10s no tick). */
export function reportRateLimit() {
  st.lastRateLimitAt = st.now();
  const to = Math.max(FLOORS.llm, Math.ceil(lanes.llm.concurrency / 2));
  if (to < lanes.llm.concurrency) {
    warn(`governor: 429 do provedor — lane llm ${lanes.llm.concurrency} -> ${to}`);
    lanes.llm.concurrency = to;
  }
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
  };
}
