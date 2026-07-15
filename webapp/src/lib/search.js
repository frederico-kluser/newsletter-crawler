// Motor da busca IA no browser — porta de src/search.js + src/llm.js do CLI:
// - soft: 1 chamada Flash(xhigh) por LOTE de ~batchSize artigos (título+resumo);
// - profunda: 1 chamada por artigo (conteúdo até maxChars, lazy via getContent).
// Rubrica, few-shots, schemas e prompts são CÓPIA dos de llm.js (variante "v2_fewshot",
// escolhida por eval — NÃO reescreva sem re-rodar o eval do repo). Validação por CLAMP
// manual (sem zod no bundle): enums fora do json_schema de propósito — strict não é garantia.
// Config (modelos/effort/lote/tetos) vem de meta.search (gerada pelo export do CLI).
import { callJSON } from './openrouter.js';
import { adaptivePool } from './pool.js';
import { configureLane, currentLimit } from './lane.js';

// Teto de concorrência por modo quando meta.search.concurrency não vem no snapshot (export antigo).
const DEFAULT_CONCURRENCY = { soft: 6, deep: 10 };
const CONCURRENCY_FLOOR = 2;

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

// ---- entendimento da consulta (spec) — porta de compileQuerySpec/specBlock de llm.js ----
const querySpecSchema = {
  type: 'object',
  properties: {
    must_have: { type: 'array', items: { type: 'string' } },
    nice_to_have: { type: 'array', items: { type: 'string' } },
    query_en: { type: 'string' },
    terms: { type: 'array', items: { type: 'string' } },
  },
  required: ['must_have', 'nice_to_have', 'query_en', 'terms'],
  additionalProperties: false,
};
// Bloco do SPEC no prompt do juiz (idêntico a specBlock de src/llm.js). Vazio sem spec = baseline.
function specBlock(spec) {
  if (!spec || (!(spec.must_have && spec.must_have.length) && !spec.query_en)) return '';
  const mh = (spec.must_have || []).map((s) => `  - ${s}`).join('\n') || '  - (nenhum explícito; use a intenção geral da consulta)';
  const nh = (spec.nice_to_have || []).map((s) => `  - ${s}`).join('\n') || '  - (nenhum)';
  return (
    'SPEC DA BUSCA (derivado da consulta do usuário):\n' +
    `OBRIGATÓRIOS (TODOS precisam bater p/ "direct"):\n${mh}\n` +
    `DESEJÁVEIS (adjacentes → no máximo "similar"):\n${nh}\n` +
    `CONSULTA (EN): ${spec.query_en || ''}\n\n` +
    'Aplicando o SPEC: "direct" = satisfaz TODOS os OBRIGATÓRIOS (resposta central); ' +
    '"similar" = só desejáveis/adjacente; "none" = não satisfaz. Compartilhar o tema amplo NÃO basta.\n\n'
  );
}
/** 1 chamada (searchSpec, Pro) que "entende" a consulta → {must_have, nice_to_have, query_en, terms}. */
export async function compileSpec({ query, search, apiKey, signal, onCost }) {
  const cfg = search.models?.searchSpec;
  if (!cfg) return null; // snapshot antigo sem searchSpec: segue com a query crua
  const out = await callJSON({
    apiKey,
    model: cfg.model,
    effort: cfg.effort,
    fallbackModel: search.models.fallback?.model || null,
    schemaName: 'query_spec',
    schema: querySpecSchema,
    signal,
    onCost,
    system:
      'Você interpreta uma CONSULTA de busca (pode estar em PT-BR e ser longa/detalhada) e devolve um ' +
      'SPEC para avaliar artigos técnicos (majoritariamente em inglês). Extraia a INTENÇÃO real: o que é ' +
      'OBRIGATÓRIO para um artigo ser resposta CENTRAL vs o que é apenas desejável/adjacente. Traduza a ' +
      'consulta e os termos-chave para inglês. NÃO invente restrições que a consulta não pede. Responda APENAS com JSON.',
    user:
      `CONSULTA: ${String(query || '').slice(0, 2000)}\n\n` +
      'Devolva JSON {"must_have":[...],"nice_to_have":[...],"query_en":"...","terms":[...]}:\n' +
      '- must_have: as condições que um artigo PRECISA satisfazer p/ ser resposta central (o foco pedido). ' +
      'Curtas e verificáveis; 1 a 6. Se a consulta for genérica, 1-2 bastam.\n' +
      '- nice_to_have: aspectos adjacentes/parciais que tornam um artigo "similar" mas não central; 0 a 6.\n' +
      '- query_en: a consulta reescrita em inglês, concisa.\n' +
      '- terms: termos-chave em inglês (sinônimos/variações) úteis p/ achar os artigos; 0 a 12.',
  });
  if (!out || typeof out !== 'object') return null;
  return {
    must_have: Array.isArray(out.must_have) ? out.must_have.map(String) : [],
    nice_to_have: Array.isArray(out.nice_to_have) ? out.nice_to_have.map(String) : [],
    query_en: String(out.query_en || ''),
    terms: Array.isArray(out.terms) ? out.terms.map(String) : [],
  };
}

// Priorização barata (F4): ordena os pendentes por overlap dos termos EN do spec com título+resumo
// — prováveis-hits nos primeiros lotes (cards relevantes streamam antes). Varre TUDO; só reordena.
const PRIO_STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'new', 'via', 'how', 'using', 'use', 'can', 'its', 'into', 'than', 'has', 'have', 'will', 'not', 'você', 'para', 'com', 'que', 'dos', 'das']);
export function prioritizeBySpec(pend, spec) {
  const src = [...(spec?.terms || []), spec?.query_en || ''].join(' ').toLowerCase();
  const words = [...new Set(src.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !PRIO_STOP.has(w)))];
  if (words.length < 2) return pend;
  const score = (a) => {
    const hay = `${a.title || a.title_pt || ''} ${a.summary_pt || a.snippet || ''}`.toLowerCase();
    let n = 0;
    for (const w of words) if (hay.includes(w)) n++;
    return n;
  };
  return pend.map((a, i) => ({ a, i, s: score(a) })).sort((x, y) => y.s - x.s || x.i - y.i).map((o) => o.a);
}

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

// ---- retomada (checkpoint p/ reload; ver lib/activeSearch.js) ----

/** Candidatos ainda NÃO julgados — a retomada pula os que já têm veredito (não repaga). */
export function filterUnjudged(candidates, judgedSet) {
  return candidates.filter((a) => !judgedSet.has(a.id));
}

/**
 * Semeia os acumuladores a partir de um checkpoint salvo: marca os ids já julgados em `verdicts`
 * (placeholder 'none' — só importa que estão julgados; os hits reais vêm em `hits`) e devolve os
 * contadores/hits/spec de onde continuar. Uma chamada em voo no reload NÃO virou veredito → seu id
 * fica de fora de judgedIds → é re-julgada ("as requests sem finalizar recomeçam").
 */
export function seedResume(resume) {
  const verdicts = new Map();
  for (const id of resume?.judgedIds || []) verdicts.set(id, { relation: 'none', kind: 'news' });
  const hits = (resume?.hits || []).map((h) => ({ id: h.id, relation: clampRelation(h.relation), kind: clampKind(h.kind) }));
  return {
    verdicts,
    hits,
    scanned: Number(resume?.scanned) || 0,
    failed: Number(resume?.failed) || 0,
    spentUsd: Number(resume?.spentUsd) || 0,
    spec: resume?.spec || null,
  };
}

/** Estado MÍNIMO p/ o checkpoint: ids julgados (pular) + hits (re-hidratar) + contadores + custo. */
export function buildCheckpoint(verdicts, hits, counters) {
  return {
    judgedIds: [...verdicts.keys()],
    hits: hits.map((h) => ({ id: h.id, relation: h.relation, kind: h.kind })),
    scanned: counters.scanned,
    relevant: hits.length,
    failed: counters.failed,
    total: counters.total,
    spentUsd: counters.spentUsd,
    spec: counters.spec || null,
  };
}

// ---- juízes (prompts verbatim de judgeRelevance/judgeRelevanceBatch, llm.js:740-817) ----

async function judgeBatch({ query, items, spec, search, apiKey, signal, onCost }) {
  const cfg = search.models.searchBatch;
  const sb = specBlock(spec);
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
      'lista de forma INDEPENDENTE' + (sb ? ' CONTRA O SPEC' : ', seguindo a rubrica e os EXEMPLOS') +
      '. Responda APENAS com JSON válido.',
    user:
      RELEVANCE_RUBRIC + '\n\n' + sb +
      `CONSULTA: ${query}\n\n` +
      'ITENS (um JSON por linha; "summary" pode estar em PT-BR):\n' +
      items.map((it) => JSON.stringify(it)).join('\n') + '\n\n' +
      'Devolva JSON {"results":[{"id","relation","kind"}]} com EXATAMENTE UMA entrada por item, ' +
      'na MESMA ordem da lista, ecoando o id EXATO de cada um. Não invente ids; não omita nenhum.',
  });
  return Array.isArray(out?.results) ? out.results : [];
}

async function judgeOne({ query, title, content, spec, search, apiKey, signal, onCost }) {
  const cfg = search.models.searchRelevance;
  const sb = specBlock(spec);
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
      'Você é um avaliador de relevância de busca, rigoroso e consistente. ' +
      (sb ? 'Julgue o ARTIGO CONTRA O SPEC. ' : 'Siga a rubrica e os EXEMPLOS. ') +
      'Responda APENAS com JSON válido.',
    user:
      RELEVANCE_RUBRIC + '\n\n' + sb +
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
export async function runSearch({ query, deep, candidates, search, apiKey, signal, onProgress, onHit, onSpec, getContent, resume = null, onCheckpoint }) {
  // Retomada: semeia ids já julgados + hits + contadores/custo de um checkpoint (lib/activeSearch.js).
  const seeded = resume ? seedResume(resume) : null;
  const verdicts = seeded ? seeded.verdicts : new Map();
  const hits = seeded ? seeded.hits : []; // acumulado AO VIVO (streaming) — o veredito empurra 1× aqui
  let spec = seeded?.spec || null;
  let spentUsd = seeded ? seeded.spentUsd : 0;
  let scanned = seeded ? seeded.scanned : 0;
  let failed = seeded ? seeded.failed : 0; // ESGOTARAM 429/erro (≠ 'none' legítimo) — "não analisados"
  const total = candidates.length; // escopo ORIGINAL completo (barra/stats corretas mesmo retomando)
  const onCost = (c) => {
    spentUsd += c;
  };
  // Concorrência AIMD: começa no teto do modo (meta.search.concurrency ou default) e a lane
  // encolhe/cresce sozinha (lane.js) conforme os 429; o pool relê currentLimit() a cada folga.
  const conc = search.concurrency || DEFAULT_CONCURRENCY;
  const ceil = Math.max(1, Math.floor((deep ? conc.deep : conc.soft) || DEFAULT_CONCURRENCY[deep ? 'deep' : 'soft']));
  configureLane({ ceil, floor: Math.min(CONCURRENCY_FLOOR, ceil) });
  const getLimit = () => currentLimit();
  const emitProgress = (mode) => onProgress?.({ mode, done: scanned, total, relevant: hits.length, failed, spentUsd });
  // Checkpoint (o CHAMADOR faz o throttle): thunk materializado só quando de fato grava.
  const checkpoint = () => onCheckpoint?.(() => buildCheckpoint(verdicts, hits, { scanned, failed, total, spentUsd, spec }));
  // Empurra o item p/ os resultados AO VIVO se o veredito for relevante (streaming via onHit).
  const pushIfRelevant = (a) => {
    const v = verdicts.get(a.id);
    if (!v || v.relation === 'none') return;
    const hit = { id: a.id, relation: v.relation, kind: v.kind };
    hits.push(hit);
    onHit?.(hit);
  };

  // Entendimento da consulta (1 chamada Pro, amortizada): spec (must-have + PT→EN) que o juiz usa —
  // busca precisão-primeiro. Fail-open: erro → query crua (spec=null). Abort/KEY_INVALID propagam.
  // Na RETOMADA o spec vem do checkpoint (não repaga a chamada Pro).
  if (!spec && candidates.length) {
    try {
      spec = await compileSpec({ query, search, apiKey, signal, onCost });
    } catch (e) {
      if (isAbort(e, signal) || e?.code === 'KEY_INVALID') throw e;
    }
  }
  if (spec) onSpec?.(spec);
  checkpoint(); // 1º checkpoint logo após o spec — um reload precoce não reperde a chamada Pro

  // Só o que FALTA julgar (busca nova = tudo; retomada = candidates − já julgados).
  const work = filterUnjudged(candidates, new Set(verdicts.keys()));

  if (deep) {
    emitProgress('deep');
    checkpoint();
    await adaptivePool(
      work,
      async (a) => {
        if (signal?.aborted) throw signal.reason || new DOMException('abortado', 'AbortError');
        try {
          const content = await getContent(a.id);
          verdicts.set(a.id, await judgeOne({ query, title: a.title, content, spec, search, apiKey, signal, onCost }));
        } catch (e) {
          if (isAbort(e, signal) || e?.code === 'KEY_INVALID') throw e;
          verdicts.set(a.id, { relation: 'none', kind: 'news' }); // fail-open
          failed++;
        }
        pushIfRelevant(a);
        scanned++;
        emitProgress('deep');
        checkpoint();
      },
      { getLimit, signal },
    );
  } else {
    // item sem título E sem texto não gasta token: veredito local 'none' (search.js:252-258)
    const pend = [];
    for (const a of work) {
      const it = toBatchItem(a);
      if (!it.title && !it.summary) verdicts.set(a.id, { relation: 'none', kind: 'news' });
      else pend.push(a);
    }
    scanned += work.length - pend.length; // INCREMENTA (soma ao scanned semeado na retomada)
    const batches = chunkBatches(prioritizeBySpec(pend, spec), search.batchSize);
    emitProgress('soft');
    checkpoint();
    await adaptivePool(
      batches,
      async (batch) => {
        if (signal?.aborted) throw signal.reason || new DOMException('abortado', 'AbortError');
        let batchFailed = false;
        try {
          const results = await judgeBatch({ query, items: batch.map(toBatchItem), spec, search, apiKey, signal, onCost });
          mergeBatchVerdicts(batch, results, verdicts);
        } catch (e) {
          if (isAbort(e, signal) || e?.code === 'KEY_INVALID') throw e;
          // fail-open: o lote inteiro vira 'none' (paridade search.js:274-281)
          for (const a of batch) verdicts.set(a.id, { relation: 'none', kind: 'news' });
          batchFailed = true;
        }
        if (batchFailed) failed += batch.length;
        else for (const a of batch) pushIfRelevant(a);
        scanned += batch.length;
        emitProgress('soft');
        checkpoint();
      },
      { getLimit, signal },
    );
  }

  hits.sort((x, y) => RANK[x.relation] - RANK[y.relation] || y.id - x.id); // direct 1º; empate: mais novo
  const truncated = hits.length > search.maxItems;
  return {
    query,
    deep,
    scanned,
    total: candidates.length,
    relevant: hits.length,
    failed,
    truncated,
    spentUsd,
    hits: hits.slice(0, search.maxItems),
  };
}
