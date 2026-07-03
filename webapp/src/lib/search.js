// Motor da busca IA no browser — porta de src/search.js + src/llm.js do CLI:
// - soft: 1 chamada Flash(xhigh) por LOTE de ~batchSize artigos (título+resumo);
// - profunda: 1 chamada por artigo (conteúdo até maxChars, lazy via getContent).
// Rubrica, few-shots, schemas e prompts são CÓPIA dos de llm.js (variante "v2_fewshot",
// escolhida por eval — NÃO reescreva sem re-rodar o eval do repo). Validação por CLAMP
// manual (sem zod no bundle): enums fora do json_schema de propósito — strict não é garantia.
// Config (modelos/effort/lote/tetos) vem de meta.search (gerada pelo export do CLI).
import { callJSON } from './openrouter.js';
import { asyncPool } from './pool.js';

// ---- clamps (porta de llm.js:709-712) ----
const RELATIONS = new Set(['direct', 'similar', 'none']);
const KINDS = new Set(['news', 'tool']);
export const clampRelation = (s) => (RELATIONS.has(String(s).toLowerCase()) ? String(s).toLowerCase() : 'none');
export const clampKind = (s) => (KINDS.has(String(s).toLowerCase()) ? String(s).toLowerCase() : 'news');

// ---- rubrica + schemas (verbatim de llm.js:717-780) ----
const RELEVANCE_RUBRIC =
  'RUBRICA relation: "direct"=foco central da consulta; "similar"=adjacente, não é o foco; "none"=sem resposta. ' +
  'Mesmo tema amplo NÃO basta para "direct". kind: "tool"=sobre biblioteca/pacote/framework/CLI; senão "news".\n\n' +
  'EXEMPLOS (consulta → artigo → saída):\n' +
  '1) "bibliotecas de inferência de LLM" → "Lib X acelera serving de LLM em GPU" → {"relation":"direct","kind":"tool"}\n' +
  '2) "bibliotecas de inferência de LLM" → "Startup de IA capta US$ 300M" → {"relation":"none","kind":"news"}\n' +
  '3) "captação de startups de IA" → "Paper novo sobre compressão de KV cache" → {"relation":"none","kind":"news"}\n' +
  '4) "regulação de IA" → "UE atrasa provisões do AI Act" → {"relation":"direct","kind":"news"}\n' +
  '5) "modelos de pesos abertos" → "Modelo PROPRIETÁRIO Y desafia rivais" → {"relation":"none","kind":"news"}';

const relevanceSchema = {
  type: 'object',
  properties: {
    relation: { type: 'string', description: 'direct | similar | none' },
    kind: { type: 'string', description: 'news | tool' },
  },
  required: ['relation', 'kind'],
  additionalProperties: false,
};

const relevanceBatchSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'id do item, ecoado EXATAMENTE' },
          relation: { type: 'string', description: 'direct | similar | none' },
          kind: { type: 'string', description: 'news | tool' },
        },
        required: ['id', 'relation', 'kind'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

// ---- helpers de lote (porta de search.js:186-227) ----

/** Entrada mínima por artigo no juiz em lote — no snapshot, o "melhor texto curto" é o snippet. */
export const toBatchItem = (a) => ({
  id: a.id,
  title: String(a.title || a.title_pt || '').slice(0, 200),
  summary: String(a.summary_pt || a.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 400),
});

/** Divide `rows` em lotes de `size` preservando a ordem. */
export function chunkBatches(rows, size) {
  const n = Math.max(1, Math.floor(size) || 1);
  const out = [];
  for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n));
  return out;
}

/**
 * Funde a resposta de UM lote em `verdicts` (id -> {relation,kind}): id faltando -> 'none'
 * (fail-open), id desconhecido -> ignorado, duplicado -> a primeira entrada vence.
 */
export function mergeBatchVerdicts(batch, results, verdicts) {
  const ids = new Set(batch.map((a) => a.id));
  const byId = new Map();
  let unknown = 0;
  for (const r of results || []) {
    const id = Number(r?.id); // o modelo às vezes ecoa o id como string
    if (!Number.isInteger(id) || !ids.has(id)) {
      unknown++;
      continue;
    }
    if (!byId.has(id)) byId.set(id, r);
  }
  let missing = 0;
  for (const a of batch) {
    const v = byId.get(a.id);
    if (!v) {
      verdicts.set(a.id, { relation: 'none', kind: 'news' });
      missing++;
    } else {
      verdicts.set(a.id, { relation: clampRelation(v.relation), kind: clampKind(v.kind) });
    }
  }
  return { missing, unknown };
}

// ---- juízes (prompts verbatim de judgeRelevance/judgeRelevanceBatch, llm.js:740-817) ----

async function judgeBatch({ query, items, search, apiKey, signal, onCost }) {
  const cfg = search.models.searchBatch;
  const out = await callJSON({
    apiKey,
    model: cfg.model,
    effort: cfg.effort,
    fallbackModel: search.models.fallback?.model || null,
    schemaName: 'relevance_batch',
    schema: relevanceBatchSchema,
    signal,
    onCost,
    system:
      'Você é um avaliador de relevância de busca, rigoroso e consistente. Avalie CADA item da ' +
      'lista de forma INDEPENDENTE, seguindo a rubrica e os EXEMPLOS. Responda APENAS com JSON válido.',
    user:
      RELEVANCE_RUBRIC + '\n\n' +
      `CONSULTA: ${query}\n\n` +
      'ITENS (um JSON por linha; "summary" pode estar em PT-BR):\n' +
      items.map((it) => JSON.stringify(it)).join('\n') + '\n\n' +
      'Devolva JSON {"results":[{"id","relation","kind"}]} com EXATAMENTE UMA entrada por item, ' +
      'na MESMA ordem da lista, ecoando o id EXATO de cada um. Não invente ids; não omita nenhum.',
  });
  return Array.isArray(out?.results) ? out.results : [];
}

async function judgeOne({ query, title, content, search, apiKey, signal, onCost }) {
  const cfg = search.models.searchRelevance;
  const out = await callJSON({
    apiKey,
    model: cfg.model,
    effort: cfg.effort,
    fallbackModel: search.models.fallback?.model || null,
    schemaName: 'relevance',
    schema: relevanceSchema,
    signal,
    onCost,
    system:
      'Você é um avaliador de relevância de busca, rigoroso e consistente. Siga a rubrica e os EXEMPLOS. ' +
      'Responda APENAS com JSON válido.',
    user:
      RELEVANCE_RUBRIC + '\n\n' +
      `CONSULTA: ${query}\n\n` +
      `ARTIGO\nTítulo: ${title || ''}\n\nConteúdo:\n${String(content || '').slice(0, search.maxChars)}\n\n` +
      'Devolva JSON {"relation","kind"}.',
  });
  return { relation: clampRelation(out?.relation), kind: clampKind(out?.kind) };
}

const isAbort = (e, signal) => signal?.aborted || e?.name === 'AbortError';
const RANK = { direct: 0, similar: 1 };

/**
 * Roda a busca sobre os `candidates` (artigos do snapshot já filtrados pelo ESCOPO fonte+
 * período). Fail-open por lote/artigo (erro vira 'none'); ABORT propaga (Cancelar de verdade).
 * KEY_INVALID propaga (o hook reabre o KeyModal). Retorna hits {id, relation, kind} direct-first
 * capados em search.maxItems + contadores + custo real acumulado.
 */
export async function runSearch({ query, deep, candidates, search, apiKey, signal, onProgress, getContent }) {
  const verdicts = new Map();
  let spentUsd = 0;
  let scanned = 0;
  const onCost = (c) => {
    spentUsd += c;
  };
  const relevantNow = () => {
    let n = 0;
    for (const v of verdicts.values()) if (v.relation !== 'none') n++;
    return n;
  };

  if (deep) {
    const total = candidates.length;
    await asyncPool(4, candidates, async (a) => {
      if (signal?.aborted) throw signal.reason || new DOMException('abortado', 'AbortError');
      let rel = { relation: 'none', kind: 'news' };
      try {
        const content = await getContent(a.id);
        rel = await judgeOne({ query, title: a.title, content, search, apiKey, signal, onCost });
      } catch (e) {
        if (isAbort(e, signal) || e?.code === 'KEY_INVALID') throw e;
        /* fail-open: erro por artigo vira 'none' */
      }
      verdicts.set(a.id, rel);
      scanned++;
      onProgress?.({ mode: 'deep', done: scanned, total, relevant: relevantNow(), spentUsd });
    });
  } else {
    // item sem título E sem texto não gasta token: veredito local 'none' (search.js:252-258)
    const pend = [];
    for (const a of candidates) {
      const it = toBatchItem(a);
      if (!it.title && !it.summary) verdicts.set(a.id, { relation: 'none', kind: 'news' });
      else pend.push(a);
    }
    scanned = candidates.length - pend.length;
    const batches = chunkBatches(pend, search.batchSize);
    let doneBatches = 0;
    onProgress?.({ mode: 'soft', done: 0, total: batches.length, relevant: 0, spentUsd });
    await asyncPool(2, batches, async (batch) => {
      if (signal?.aborted) throw signal.reason || new DOMException('abortado', 'AbortError');
      try {
        const results = await judgeBatch({ query, items: batch.map(toBatchItem), search, apiKey, signal, onCost });
        mergeBatchVerdicts(batch, results, verdicts);
      } catch (e) {
        if (isAbort(e, signal) || e?.code === 'KEY_INVALID') throw e;
        // fail-open: o lote inteiro vira 'none' (paridade search.js:274-281)
        for (const a of batch) verdicts.set(a.id, { relation: 'none', kind: 'news' });
      }
      scanned += batch.length;
      doneBatches++;
      onProgress?.({ mode: 'soft', done: doneBatches, total: batches.length, relevant: relevantNow(), spentUsd });
    });
  }

  const hits = [];
  for (const a of candidates) {
    const rel = verdicts.get(a.id);
    if (!rel || rel.relation === 'none') continue;
    hits.push({ id: a.id, relation: rel.relation, kind: rel.kind });
  }
  hits.sort((x, y) => RANK[x.relation] - RANK[y.relation] || y.id - x.id); // direct 1º; empate: mais novo
  const truncated = hits.length > search.maxItems;
  return {
    query,
    deep,
    scanned,
    total: candidates.length,
    relevant: hits.length,
    truncated,
    spentUsd,
    hits: hits.slice(0, search.maxItems),
  };
}
