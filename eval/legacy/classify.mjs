// CONGELADO de src/taxonomy.js + src/llm.js (etapas classify/searchTags): buildFacetPrompt,
// buildFacetQueryPrompt, o schema facet_tags/search_tags e a validação por vocabulário
// (getFacets/validateFacetTags). O VOCABULÁRIO não é copiado: é lido de config/taxonomy.json
// (dado versionado, não código que a migração apaga) — o baseline usa a MESMA taxonomia da gold.
// Texto, json_schema e parse copiados VERBATIM (ver _shared.mjs → FROZEN_FROM). NÃO edite.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_CLASSIFY_MAX_CHARS, legacyRequest, parseWith, t } from './_shared.mjs';

const TAXONOMY_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'taxonomy.json');

// Carga preguiçosa e memoizada (importar este módulo não lê o disco), como em taxonomy.js.
// `taxonomy` explícito (teste/experimento) ignora o arquivo.
let _tax = null;
function getTaxonomy(taxonomy) {
  if (taxonomy) return taxonomy;
  if (!_tax) _tax = JSON.parse(readFileSync(TAXONOMY_PATH, 'utf8'));
  return _tax;
}

const uniq = (arr) => [...new Set(arr)];

// Ordem dos 9 agentes (congelada).
export const FACET_ORDER = [
  'domain',
  'content-type',
  'topic-technology',
  'difficulty',
  'ecosystem-language',
  'company-vendor-model',
  'framework-library-tool',
  'concept-theme',
  'trending-emerging',
];

/** Os 9 agentes/facetas com vocabulário, Set e limites — mesma montagem de taxonomy.js. */
export function getLegacyFacets(taxonomy) {
  const tax = getTaxonomy(taxonomy);
  const f = tax.facets || {};
  const topicUnion = uniq([
    ...Object.values(tax.topics_by_domain || {}).flat(),
    ...((tax.ai_engineering_cross && tax.ai_engineering_cross.topics) || []),
  ]);
  const toolUnion = uniq([
    ...Object.values(tax.tools_by_domain || {}).flat(),
    ...((tax.ai_engineering_cross && tax.ai_engineering_cross.tools) || []),
  ]);
  const vocabByName = {
    domain: f.domain,
    'content-type': f['content-type'],
    'topic-technology': topicUnion,
    difficulty: f.difficulty,
    'ecosystem-language': f['ecosystem-language'],
    'company-vendor-model': f['company-vendor-model'],
    'framework-library-tool': toolUnion,
    'concept-theme': f['concept-theme'],
    'trending-emerging': f['trending-emerging'],
  };
  const mandatory = new Set(tax.mandatory || []);
  return FACET_ORDER.map((name) => {
    const vocab = vocabByName[name] || [];
    const [min, max] = tax.limits?.[name] || [0, 6];
    return { name, vocab, set: new Set(vocab), min, max, mandatory: mandatory.has(name) };
  });
}

function normalizeTag(facet, raw, tax) {
  const tag = String(raw || '').trim().toLowerCase();
  if (!tag) return null;
  if (facet.set.has(tag)) return tag;
  const alias = tax.aliases?.[tag];
  if (alias && facet.set.has(alias)) return alias;
  return null;
}

/** validateFacetTags congelado: alias → vocabulário → dedup → corte no máximo da faceta. */
export function validateLegacyFacetTags(facetName, rawTags, taxonomy) {
  const tax = getTaxonomy(taxonomy);
  const facet = getLegacyFacets(taxonomy).find((x) => x.name === facetName);
  if (!facet) return { tags: [], dropped: [] };
  const out = [];
  const seen = new Set();
  const dropped = [];
  for (const raw of rawTags || []) {
    const norm = normalizeTag(facet, raw, tax);
    if (norm) {
      if (!seen.has(norm)) {
        seen.add(norm);
        out.push(norm);
      }
    } else {
      dropped.push(String(raw));
    }
  }
  return { tags: out.slice(0, facet.max), dropped };
}

export const facetSchema = {
  type: 'object',
  properties: {
    tags: { type: 'array', items: { type: 'string' } },
    uncovered: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['tags', 'uncovered', 'confidence'],
  additionalProperties: false,
};
// facetZ sem zod: tudo obrigatório, sem default.
const FACET_SHAPE = {
  tags: t.array(t.string()),
  uncovered: t.array(t.string()),
  confidence: t.number(),
};
export const parseFacet = (raw, opts) => parseWith(FACET_SHAPE, raw, opts);

export const searchTagsSchema = {
  type: 'object',
  properties: { tags: { type: 'array', items: { type: 'string' } } },
  required: ['tags'],
  additionalProperties: false,
};
const SEARCH_TAGS_SHAPE = { tags: t.array(t.string()) };
export const parseSearchTags = (raw, opts) => parseWith(SEARCH_TAGS_SHAPE, raw, opts);
// mapQueryToFacetTags devolvia `.tags` (é o `req.parse` do builder de consulta).
const parseSearchTagsReturn = (raw, opts) => parseSearchTags(raw, opts)?.tags ?? null;

/** buildFacetPrompt(facet, article) congelado → {system, user}. `facet` = item de getLegacyFacets. */
export function buildFacetPrompt(facet, article, { taxonomy = null, maxChars = LEGACY_CLASSIFY_MAX_CHARS } = {}) {
  const tax = getTaxonomy(taxonomy);
  const { name, min, max } = facet;
  const aliasLines = Object.entries(tax.aliases || {})
    .map(([k, v]) => `${k} -> ${v}`)
    .join('\n');
  const content = String(article.content || '').slice(0, maxChars);
  const system =
    'Você é um catalogador de conteúdo técnico de newsletters. Classifique o artigo na ' +
    `faceta "${name}" usando EXCLUSIVAMENTE o vocabulário controlado fornecido. ` +
    'Responda apenas com JSON.';
  const user =
    `FACETA: ${name}\n` +
    `LIMITE: de ${min} a ${max} tags.\n\n` +
    'REGRAS:\n' +
    '1. Só escolha tags que existam LITERALMENTE no vocabulário abaixo. Nunca invente tags.\n' +
    '2. Normalize variantes pela tabela de aliases antes de atribuir (ex.: "js" -> "javascript").\n' +
    `3. Atribua de ${min} a ${max} tags${min > 0 ? ' (faceta OBRIGATÓRIA, mínimo ' + min + ').' : ' (pode ser 0).'}\n` +
    '4. Escolha a tag MAIS ESPECÍFICA disponível; só use genérica se não houver específica.\n' +
    '5. Ordene as tags por relevância (mais relevante primeiro).\n' +
    '6. Se um assunto central desta faceta NÃO estiver no vocabulário, registre-o como TEXTO ' +
    'LIVRE em "uncovered" (máx. 3 itens); nunca crie slug novo.\n' +
    '7. "confidence" é sua confiança (0.0–1.0) na atribuição desta faceta.\n' +
    '8. Devolva SOMENTE JSON no formato: {"tags":[...],"uncovered":[...],"confidence":0.0}\n\n' +
    `VOCABULÁRIO CONTROLADO (faceta "${name}"):\n${facet.vocab.join(', ')}\n\n` +
    `TABELA DE ALIASES (variante -> canônico):\n${aliasLines}\n\n` +
    `ARTIGO\nTítulo: ${article.title || ''}\n\nConteúdo:\n${content}`;
  return { system, user };
}

/**
 * classifyFacet de UMA faceta congelado (o original rodava as 9 em paralelo). Model/effort POR
 * faceta como o classifyFacetModel: `classify:<faceta>` se existir, senão a base `classify`.
 * Aceita o nome da faceta ou o objeto de getLegacyFacets.
 */
export function buildFacetRequest(facetOrName, article, opts = {}) {
  const facet =
    typeof facetOrName === 'string'
      ? getLegacyFacets(opts.taxonomy).find((x) => x.name === facetOrName)
      : facetOrName;
  if (!facet) throw new Error(`faceta desconhecida: ${facetOrName}`);
  const { system, user } = buildFacetPrompt(facet, article, opts);
  return {
    ...legacyRequest(
      {
        stage: 'classify',
        modelKey: `classify:${facet.name}`,
        schemaName: 'facet_tags',
        schema: facetSchema,
        parse: parseFacet,
        system,
        user,
      },
      opts,
    ),
    facet: facet.name,
  };
}

/** buildFacetQueryPrompt(facet, query) congelado → {system, user} (modo B da busca). */
export function buildFacetQueryPrompt(facet, query, { taxonomy = null } = {}) {
  const tax = getTaxonomy(taxonomy);
  const { name, max } = facet;
  const aliasLines = Object.entries(tax.aliases || {})
    .map(([k, v]) => `${k} -> ${v}`)
    .join('\n');
  const system =
    `Você mapeia uma CONSULTA de busca para tags da faceta "${name}", usando EXCLUSIVAMENTE ` +
    'o vocabulário controlado fornecido. Responda apenas com JSON.';
  const user =
    `FACETA: ${name}\n` +
    `TAREFA: liste as tags DESTA faceta que melhor representam a CONSULTA (0 a ${max}).\n\n` +
    'REGRAS:\n' +
    '1. Só use tags que existam LITERALMENTE no vocabulário abaixo. Nunca invente.\n' +
    '2. Normalize variantes pela tabela de aliases (ex.: "js" -> "javascript").\n' +
    '3. Inclua só o que for claramente relevante; se nada se aplica, devolva [].\n' +
    '4. Devolva SOMENTE JSON: {"tags":[...]}.\n\n' +
    `VOCABULÁRIO CONTROLADO (faceta "${name}"):\n${facet.vocab.join(', ')}\n\n` +
    `TABELA DE ALIASES (variante -> canônico):\n${aliasLines}\n\n` +
    `CONSULTA: ${query}`;
  return { system, user };
}

/** mapQueryToFacetTags de UMA faceta congelado (modo B: 1 chamada por faceta de RETRIEVAL). */
export function buildFacetQueryRequest(facetOrName, query, opts = {}) {
  const facet =
    typeof facetOrName === 'string'
      ? getLegacyFacets(opts.taxonomy).find((x) => x.name === facetOrName)
      : facetOrName;
  if (!facet) throw new Error(`faceta desconhecida: ${facetOrName}`);
  const { system, user } = buildFacetQueryPrompt(facet, query, opts);
  return {
    ...legacyRequest(
      { stage: 'searchTags', schemaName: 'search_tags', schema: searchTagsSchema, parse: parseSearchTagsReturn, system, user },
      opts,
    ),
    facet: facet.name,
  };
}

// Facetas úteis p/ RETRIEVAL no modo B (congelado de taxonomy.js).
export const RETRIEVAL_FACETS = [
  'domain',
  'topic-technology',
  'framework-library-tool',
  'concept-theme',
  'trending-emerging',
];
