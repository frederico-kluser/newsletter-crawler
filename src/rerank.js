// Rerank por CROSS-ENCODER (bge-reranker via transformers.js/onnxruntime) — o maior ganho isolado
// de precisão do retrieval: pontua pares (consulta, documento) atendendo aos DOIS juntos, muito
// mais discriminante que o cosseno do bi-encoder. Lazy-loaded (singleton); o modelo (q8, ~280MB)
// baixa 1x p/ NC_HOME/models. Fail-open: se não carregar, rerankScores devolve null e o chamador
// mantém a ordem RRF. Usado no fim do hybridCandidates (retrieval.js).
import path from 'node:path';
import { NC_HOME, RERANK_MODEL } from './config.js';
import { debug } from './util.js';

let _tok = null;
let _model = null;
let _failed = false;

async function getReranker() {
  if (_model) return { tok: _tok, model: _model };
  if (_failed) return null;
  try {
    const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import('@huggingface/transformers');
    env.cacheDir = path.join(NC_HOME, 'models');
    env.allowRemoteModels = true;
    debug(`rerank: carregando ${RERANK_MODEL} (baixa na 1ª vez)…`);
    _tok = await AutoTokenizer.from_pretrained(RERANK_MODEL);
    _model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: 'q8' });
    return { tok: _tok, model: _model };
  } catch (e) {
    debug(`rerank: modelo indisponível (${e.message}); rerank desligado (mantém a ordem RRF)`);
    _failed = true;
    return null;
  }
}

/**
 * Pontua pares (query, doc) com o cross-encoder. Retorna scores ALINHADOS a `docs` (maior = mais
 * relevante), em lotes de `batch` (limita memória/pad). null se o modelo não carregar (fail-open).
 */
export async function rerankScores(query, docs, { batch = 32 } = {}) {
  if (!docs.length) return [];
  const r = await getReranker();
  if (!r) return null;
  const scores = [];
  for (let i = 0; i < docs.length; i += batch) {
    const chunk = docs.slice(i, i + batch);
    const inputs = r.tok(new Array(chunk.length).fill(query), { text_pair: chunk, padding: true, truncation: true });
    const { logits } = await r.model(inputs);
    for (const row of logits.tolist()) scores.push(row[0]);
  }
  return scores;
}
