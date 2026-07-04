// Embeddings LOCAIS (bge-small-en-v1.5 via transformers.js/onnxruntime) — a metade DENSA do
// retrieval híbrido. O pipeline é lazy-loaded (singleton): o modelo (~130MB) baixa 1x p/
// NC_HOME/models e fica cacheado; nenhum comando que NÃO busca/backfill paga isso. 384 dims,
// normalizado (cosseno = produto interno). O bge usa um PREFIXO de instrução SÓ na consulta.
import path from 'node:path';
import { db, stmts, VEC_OK } from './db.js';
import { NC_HOME, EMBED_MODEL, EMBED_BATCH } from './config.js';
import { debug, warn } from './util.js';

const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

let _pipe = null;
async function getPipe() {
  if (_pipe) return _pipe;
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = path.join(NC_HOME, 'models'); // cache local-first (fora do repo)
  env.allowRemoteModels = true;
  debug(`embed: carregando ${EMBED_MODEL} (baixa na 1ª vez)…`);
  _pipe = await pipeline('feature-extraction', EMBED_MODEL);
  return _pipe;
}

// Float32Array -> BLOB (Uint8Array) que o better-sqlite3/sqlite-vec aceitam no bind.
export const toBlob = (v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

/** Embed de N textos -> Float32Array[] (cada um normalizado). Lote único (a lib já paraleliza). */
export async function embedTexts(texts) {
  if (!texts.length) return [];
  const pipe = await getPipe();
  const out = await pipe(texts, { pooling: 'mean', normalize: true });
  const d = out.dims[1];
  const vecs = [];
  for (let i = 0; i < out.dims[0]; i++) vecs.push(out.data.slice(i * d, (i + 1) * d));
  return vecs;
}

/** Embed de UMA consulta (com o prefixo de instrução do bge). */
export async function embedQuery(query) {
  const [v] = await embedTexts([QUERY_PREFIX + String(query || '').slice(0, 2000)]);
  return v || null;
}

// Texto representativo do artigo p/ embedding: título + cabeça do conteúdo (EN; o modelo é EN).
const articleText = (r) => `${r.title || ''}. ${r.content_head || ''}`.trim();

/**
 * Gera e grava os embeddings dos artigos SEM vetor (delta/idempotente). Em lotes de EMBED_BATCH,
 * cada lote numa transação. Fail-open se o sqlite-vec não carregou. @returns {{embedded:number}}
 */
export async function backfillEmbeddings({ limit = Infinity, onProgress = null } = {}) {
  if (!VEC_OK) {
    warn('embed: sqlite-vec indisponível; backfill de embeddings pulado.');
    return { embedded: 0 };
  }
  let embedded = 0;
  for (;;) {
    const take = Math.min(EMBED_BATCH, limit - embedded);
    if (take <= 0) break;
    const rows = stmts.articlesMissingVec.all(take);
    if (!rows.length) break;
    const vecs = await embedTexts(rows.map(articleText));
    const tx = db.transaction(() => {
      rows.forEach((r, i) => stmts.insertVec.run(BigInt(r.id), toBlob(vecs[i])));
    });
    tx();
    embedded += rows.length;
    onProgress?.(embedded);
  }
  return { embedded };
}
