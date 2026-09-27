// CONGELADO de src/llm.js (etapas searchRelevance/searchBatch/searchSpec): RELEVANCE_RUBRIC,
// judgeRelevance, buildBatchJudgePrompt/judgeRelevanceBatch (+ specBlock) e compileQuerySpec.
// A rubrica é a "v2_fewshot" escolhida por eval (F1 macro Flash 0.848 — eval/REPORT.md).
// Texto, json_schema e parse copiados VERBATIM (ver _shared.mjs → FROZEN_FROM). NÃO edite.
import { LEGACY_SEARCH_MAX_CHARS, legacyRequest, parseWith, t } from './_shared.mjs';

const RELATIONS = new Set(['direct', 'similar', 'none']);
const KINDS = new Set(['news', 'tool']);
const clampRelation = (s) => (RELATIONS.has(String(s).toLowerCase()) ? String(s).toLowerCase() : 'none');
const clampKind = (s) => (KINDS.has(String(s).toLowerCase()) ? String(s).toLowerCase() : 'news');

export const RELEVANCE_RUBRIC =
  'RUBRICA relation: "direct"=foco central da consulta; "similar"=adjacente, não é o foco; "none"=sem resposta. ' +
  'Mesmo tema amplo NÃO basta para "direct". kind: "tool"=sobre biblioteca/pacote/framework/CLI; senão "news".\n\n' +
  'EXEMPLOS (consulta → artigo → saída):\n' +
  '1) "bibliotecas de inferência de LLM" → "Lib X acelera serving de LLM em GPU" → {"relation":"direct","kind":"tool"}\n' +
  '2) "bibliotecas de inferência de LLM" → "Startup de IA capta US$ 300M" → {"relation":"none","kind":"news"}\n' +
  '3) "captação de startups de IA" → "Paper novo sobre compressão de KV cache" → {"relation":"none","kind":"news"}\n' +
  '4) "regulação de IA" → "UE atrasa provisões do AI Act" → {"relation":"direct","kind":"news"}\n' +
  '5) "modelos de pesos abertos" → "Modelo PROPRIETÁRIO Y desafia rivais" → {"relation":"none","kind":"news"}';

export const relevanceSchema = {
  type: 'object',
  properties: {
    relation: { type: 'string', description: 'direct | similar | none' },
    kind: { type: 'string', description: 'news | tool' },
  },
  required: ['relation', 'kind'],
  additionalProperties: false,
};
const RELEVANCE_SHAPE = {
  relation: t.map(t.string(), clampRelation),
  kind: t.map(t.string(), clampKind),
};
export const parseRelevance = (raw, opts) => parseWith(RELEVANCE_SHAPE, raw, opts);

export const relevanceBatchSchema = {
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
// id coercível (o modelo às vezes ecoa o id como string), como o z.coerce.number().int().
const RELEVANCE_BATCH_SHAPE = {
  results: t.array(
    t.object({
      id: t.coerceNumber({ int: true }),
      relation: t.map(t.string(), clampRelation),
      kind: t.map(t.string(), clampKind),
    }),
  ),
};
export const parseRelevanceBatch = (raw, opts) => parseWith(RELEVANCE_BATCH_SHAPE, raw, opts);
// O original devolvia `.results` (é o `req.parse`); a fusão tolerante a ids ficava no chamador
// (mergeBatchVerdicts, search.js).
const parseRelevanceBatchReturn = (raw, opts) => parseRelevanceBatch(raw, opts)?.results ?? null;

// Bloco do SPEC (busca precisão-primeiro). Vazio sem spec = baseline eval-locked v2_fewshot.
export function specBlock(spec) {
  if (!spec || (!spec.must_have?.length && !spec.query_en)) return '';
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

/** buildBatchJudgePrompt({query, items, spec}) congelado → {system, user}. */
export function buildBatchJudgePrompt({ query, items, spec = null }) {
  const sb = specBlock(spec);
  return {
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
  };
}

/** judgeRelevanceBatch({query, items:[{id,title,summary}], spec}) congelado (busca soft da web). */
export function buildRelevanceBatchRequest({ query, items, spec = null }, opts = {}) {
  const { system, user } = buildBatchJudgePrompt({ query, items, spec });
  return legacyRequest(
    {
      stage: 'searchBatch',
      schemaName: 'relevance_batch',
      schema: relevanceBatchSchema,
      parse: parseRelevanceBatchReturn,
      system,
      user,
    },
    opts,
  );
}

/** judgeRelevance({query, title, content, spec}) congelado (modo A, 1 artigo por chamada). */
export function buildRelevanceRequest({ query, title, content, spec = null }, opts = {}) {
  const maxChars = opts.maxChars ?? LEGACY_SEARCH_MAX_CHARS;
  const sb = specBlock(spec);
  return legacyRequest(
    {
      stage: 'searchRelevance',
      schemaName: 'relevance',
      schema: relevanceSchema,
      parse: parseRelevance,
      system:
        'Você é um avaliador de relevância de busca, rigoroso e consistente. ' +
        (sb ? 'Julgue o ARTIGO CONTRA O SPEC. ' : 'Siga a rubrica e os EXEMPLOS. ') +
        'Responda APENAS com JSON válido.',
      user:
        RELEVANCE_RUBRIC + '\n\n' + sb +
        `CONSULTA: ${query}\n\n` +
        `ARTIGO\nTítulo: ${title || ''}\n\nConteúdo:\n${String(content || '').slice(0, maxChars)}\n\n` +
        'Devolva JSON {"relation","kind"}.',
    },
    opts,
  );
}

export const querySpecSchema = {
  type: 'object',
  properties: {
    must_have: { type: 'array', items: { type: 'string' }, description: 'critérios OBRIGATÓRIOS (todos precisam bater p/ ser resposta central); 1-6 itens curtos' },
    nice_to_have: { type: 'array', items: { type: 'string' }, description: 'critérios desejáveis/adjacentes; 0-6 itens curtos' },
    query_en: { type: 'string', description: 'a consulta reescrita/traduzida em inglês, concisa' },
    terms: { type: 'array', items: { type: 'string' }, description: 'termos-chave em inglês p/ recuperação (0-12)' },
  },
  required: ['must_have', 'nice_to_have', 'query_en', 'terms'],
  additionalProperties: false,
};
const QUERY_SPEC_SHAPE = {
  must_have: t.withDefault(t.array(t.string()), () => []),
  nice_to_have: t.withDefault(t.array(t.string()), () => []),
  query_en: t.withDefault(t.string(), ''),
  terms: t.withDefault(t.array(t.string()), () => []),
};
export const parseQuerySpec = (raw, opts) => parseWith(QUERY_SPEC_SHAPE, raw, opts);

/** compileQuerySpec(query) congelado → spec {must_have, nice_to_have, query_en, terms}. */
export function buildQuerySpecRequest(query, opts = {}) {
  return legacyRequest(
    {
      stage: 'searchSpec',
      schemaName: 'query_spec',
      schema: querySpecSchema,
      parse: parseQuerySpec,
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
    },
    opts,
  );
}
