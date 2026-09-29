// POST /api/admin/scope — estimativa ao vivo para a página: nº de artigos no escopo do filtro
// atual (mesma semântica do site) + custo estimado da análise JEV. Barato: o snapshot está
// cacheado na instância (data.js) e não há chamada de LLM.
import { planBatches, resolveScope } from '../_lib/analyze.js';
import { requireAdmin } from '../_lib/auth.js';
import { DEFAULT_THRESHOLD, adminSecrets, clampBatchSize, dataBaseUrl, env } from '../_lib/env.js';
import { allowMethod, bad, readJsonBody, sendJson } from '../_lib/http.js';
import { loadSnapshot } from '../_lib/data.js';

// ~tokens de entrada por artigo julgado (state do batch + pergunta), medida conservadora;
// o Jev cobra só entrada a US$ 0,042/M tokens (saída grátis).
const INPUT_TOKENS_PER_ARTICLE = 160;
const JEV_INPUT_PRICE_PER_M = 0.042;

export default async function handler(req, res) {
  const m = allowMethod(req, res, 'POST');
  if (!m) return;
  const secrets = adminSecrets();
  const guard = requireAdmin(req, secrets);
  if (!guard.ok) return bad(res, guard.status, guard.code, guard.message);
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return bad(res, 400, 'bad-json', 'corpo JSON inválido');
  }
  const { meta, articles } = await loadSnapshot(dataBaseUrl());
  const config = {
    input: String(body?.input || ''),
    from: body?.from || '',
    to: body?.to || '',
    sourceIds: body?.sourceIds || [],
    kind: body?.kind || 'all',
    threshold: Number(body?.threshold) || DEFAULT_THRESHOLD,
    batchSize: clampBatchSize(body?.batchSize),
  };
  const scoped = resolveScope(articles, meta, config);
  const batches = planBatches(scoped, { input: config.input, batchSize: config.batchSize });
  const total = scoped.length;
  const estUsd = (total * INPUT_TOKENS_PER_ARTICLE * JEV_INPUT_PRICE_PER_M) / 1e6;
  return sendJson(res, 200, { total, batches: batches.length, estUsd: Number(estUsd.toFixed(4)) });
}
