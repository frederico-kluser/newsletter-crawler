// Cache em disco das respostas do eval (Jev, Gemini, baselines legados).
//
// Por que: toda resposta paga é guardada com a distribuição inteira, então varrer limiares,
// re-pontuar ou re-rodar um estágio custa US$ 0 — só um pedido NOVO (texto, perguntas, modelo ou
// effort diferentes) vai à rede. A chave é o sha256 do pedido CANÔNICO (chaves ordenadas), logo
// a ordem das chaves no objeto não muda a chave; qualquer byte de conteúdo muda.
//
// Layout: <dir>/<namespace>/<sha[0:2]>/<sha>.json → {key, namespace, createdAt, request?, response, meta}.
// Default eval/jev/.cache (ignorado no git). Escrita atômica (tmp + rename): um Ctrl-C no meio de
// um run pago nunca deixa um JSON truncado que envenenaria a próxima leitura.
import crypto from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { warn } from '../../../src/util.js';

export const DEFAULT_CACHE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache');

/**
 * JSON canônico: chaves de objeto ordenadas (recursivo), arrays na ordem, e a mesma semântica do
 * JSON.stringify p/ o resto (undefined/função/símbolo somem em objeto e viram null em array;
 * NaN/Infinity viram null; toJSON é respeitado, p/ Date). -0 vira 0.
 */
export function canonicalize(value) {
  return JSON.stringify(normalizeForKey(value)) ?? 'null';
}

function normalizeForKey(v) {
  if (v && typeof v.toJSON === 'function') v = v.toJSON();
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? (Object.is(v, -0) ? 0 : v) : null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    return v.map((x) => {
      const n = normalizeForKey(x);
      return n === undefined || typeof n === 'function' || typeof n === 'symbol' ? null : n;
    });
  }
  const out = {};
  for (const k of Object.keys(v).sort()) {
    const n = normalizeForKey(v[k]);
    if (n === undefined || typeof n === 'function' || typeof n === 'symbol') continue;
    out[k] = n;
  }
  return out;
}

/** sha256 hex do pedido canônico — a chave estável do cache. */
export function requestKey(request) {
  if (request === undefined || request === null) throw new Error('eval cache: pedido vazio não tem chave');
  return crypto.createHash('sha256').update(canonicalize(request)).digest('hex');
}

const safeNamespace = (ns) => String(ns || 'default').replace(/[^a-zA-Z0-9._-]+/g, '_');

/**
 * Abre (cria sob demanda) um cache. `namespace` separa estágios/engines (ex.: 'verifyRecordJev',
 * 'legacy:curate'); `storeRequest:false` não grava o pedido junto (economiza disco em states grandes).
 */
export function createCache({ dir = process.env.EVAL_CACHE_DIR || DEFAULT_CACHE_DIR, namespace = 'default', storeRequest = true } = {}) {
  const root = path.join(path.resolve(dir), safeNamespace(namespace));
  const fileOf = (key) => path.join(root, key.slice(0, 2), `${key}.json`);
  let hits = 0;
  let misses = 0;
  let writes = 0;

  // Leitura fail-open: arquivo corrompido/ilegível = miss (a próxima escrita o substitui).
  function readEntry(key) {
    const file = fileOf(key);
    if (!existsSync(file)) return undefined;
    try {
      const entry = JSON.parse(readFileSync(file, 'utf8'));
      return entry && entry.key === key ? entry : undefined;
    } catch (e) {
      warn(`eval cache: entrada ilegível ${file} (${e.message}); tratando como miss`);
      return undefined;
    }
  }

  const api = {
    dir: root,
    namespace: safeNamespace(namespace),
    keyOf: requestKey,
    pathOf: (request) => fileOf(requestKey(request)),
    has(request) {
      return readEntry(requestKey(request)) !== undefined;
    },
    /** Resposta guardada (ou undefined). */
    get(request) {
      const entry = readEntry(requestKey(request));
      if (entry === undefined) {
        misses++;
        return undefined;
      }
      hits++;
      return entry.response;
    },
    /** Registro completo {key, createdAt, request?, response, meta} (ou undefined). */
    getEntry(request) {
      return readEntry(requestKey(request));
    },
    /** Grava a resposta; devolve a chave. `response` precisa ser serializável em JSON. */
    put(request, response, meta = null) {
      if (response === undefined) throw new Error('eval cache: response undefined não é cacheável');
      const key = requestKey(request);
      const file = fileOf(key);
      mkdirSync(path.dirname(file), { recursive: true });
      const entry = { key, namespace: api.namespace, createdAt: new Date().toISOString(), response, meta };
      if (storeRequest) entry.request = request;
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(entry));
      renameSync(tmp, file);
      writes++;
      return key;
    },
    delete(request) {
      const file = fileOf(requestKey(request));
      if (!existsSync(file)) return false;
      rmSync(file, { force: true });
      return true;
    },
    /**
     * Get-or-compute: hit devolve sem chamar `fn`; miss chama `fn()` e grava SÓ se resolver (erro
     * nunca é cacheado — um 429 de hoje não pode virar resposta permanente).
     */
    async getOrCompute(request, fn, meta = null) {
      const cached = api.get(request);
      if (cached !== undefined) return { value: cached, hit: true, key: requestKey(request) };
      const value = await fn();
      const key = api.put(request, value, typeof meta === 'function' ? meta(value) : meta);
      return { value, hit: false, key };
    },
    /** Quantas entradas há no namespace (varre o disco — só p/ relatório). */
    size() {
      if (!existsSync(root)) return 0;
      let n = 0;
      for (const sub of readdirSync(root)) {
        try {
          n += readdirSync(path.join(root, sub)).filter((f) => f.endsWith('.json')).length;
        } catch {
          /* entrada que não é diretório: ignora */
        }
      }
      return n;
    },
    stats: () => ({ hits, misses, writes }),
  };
  return api;
}
