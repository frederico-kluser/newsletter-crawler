// Cooldown de hosts MORTOS (DNS não resolve / conexão recusada / SSL morto): um host que acabou de
// morrer NÃO é martelado a cada run — re-tenta depois do TTL. Isto NÃO aposenta nada (a política
// ENRICH_MAX_ATTEMPTS=0 desta máquina — "em falha ela volta a ser processada" — continua intacta):
// o item fica com o blurb e o alvo volta a ser tentado quando o TTL expira. Medido 2026-10-10:
// 6 domínios mortos re-tentados em TODA run (blog.reco.ai, blog.toonk.com, survey.stateofhtml.com,
// releaserun.com, mastro.ai, font-size-adjust-calculator.com).
//
//   DEAD_HOST_TTL_MS   TTL do cooldown (default 24h; 0 = DESLIGA e tudo re-tenta como antes)
//
// Persistência: NC_HOME/dead-hosts.json (cache transitório — não é acervo; sai com o NC_HOME).
// Fail-open por construção: qualquer erro de filesystem só ignora o cache (re-tenta, como antes).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ncHomeDir } from './util.js';

const TTL_DEFAULT_MS = 24 * 60 * 60 * 1000;

let _cache = null; // { [host]: { at, fails, error } }

function ttlMs() {
  const n = Number(process.env.DEAD_HOST_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : TTL_DEFAULT_MS;
}

const file = () => path.join(ncHomeDir(), 'dead-hosts.json');

function load() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(readFileSync(file(), 'utf8'));
  } catch {
    _cache = {};
  }
  return _cache;
}

function save() {
  try {
    mkdirSync(ncHomeDir(), { recursive: true });
    writeFileSync(file(), JSON.stringify(_cache));
  } catch { /* fail-open: sem cache, re-tenta como antes */ }
}

/** Milissegundos restantes de cooldown do host (0 = pode tentar já). */
export function hostCooldownMs(host, now = Date.now()) {
  const ttl = ttlMs();
  if (!ttl || !host) return 0;
  const at = Number(load()[host]?.at);
  if (!Number.isFinite(at) || at <= 0) return 0;
  return Math.max(0, at + ttl - now);
}

/** Regista a MORTE do host (inicia/reforça o cooldown). Nunca lança. */
export function noteDeadHost(host, error = null, now = Date.now()) {
  const ttl = ttlMs();
  if (!ttl || !host) return;
  const c = load();
  const prev = c[host];
  c[host] = {
    at: now,
    fails: (prev?.fails || 0) + 1,
    error: String(error?.message ?? error ?? '').slice(0, 200),
  };
  save();
}

/** Estado bruto p/ diagnóstico/testes. */
export function deadHostsSnapshot() {
  return { ...load() };
}

/** Zera o cache (testes/manutenção). */
export function resetDeadHosts() {
  _cache = {};
  save();
}
