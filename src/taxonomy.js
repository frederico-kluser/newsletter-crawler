// Vocabulário controlado da classificação: facetas, prompts por faceta, normalização por
// alias e validação contra o Set de cada faceta. Módulo PURO (sem LLM/SQL/fetch), para
// poder ser usado por classify.js sem ciclos. Carga preguiçosa e memoizada: importar este
// módulo NÃO lê o disco — só a primeira chamada de função carrega o taxonomy.json, de modo
// que `npm run status` (que importa tudo, mas não classifica) não quebra se algo faltar.
import { loadTaxonomy, CLASSIFY_MAX_CHARS } from './config.js';

let _tax = null;
function getTaxonomy() {
  if (!_tax) _tax = loadTaxonomy();
  return _tax;
}

const uniq = (arr) => [...new Set(arr)];

// Ordem dos 9 agentes. topic-technology e framework-library-tool são montados a partir da
// UNIÃO de todos os domínios + o vocabulário transversal de AI engineering.
const FACET_ORDER = [
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

let _facets = null;
function buildFacets() {
  const tax = getTaxonomy();
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

/** Os 9 agentes/facetas com seu vocabulário, Set e limites. Memoizado. */
export function getFacets() {
  if (!_facets) _facets = buildFacets();
  return _facets;
}

function facetByName(name) {
  return getFacets().find((x) => x.name === name);
}

export function taxonomyVersion() {
  return getTaxonomy().version || null;
}

// Normaliza um tag para UMA faceta: se já está no vocabulário, mantém; senão tenta o alias
// (só se o canônico existir nESTA faceta — evita a colisão domínio "reactjs" vs tool "react");
// caso contrário é inválido para a faceta. Retorna o slug canônico ou null.
function normalizeTag(facet, raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return null;
  if (facet.set.has(t)) return t;
  const alias = getTaxonomy().aliases?.[t];
  if (alias && facet.set.has(alias)) return alias;
  return null;
}

/**
 * Valida a lista de tags devolvida pelo modelo para uma faceta: normaliza por alias,
 * descarta o que estiver fora do vocabulário, deduplica preservando a ordem e corta no
 * máximo da faceta. Retorna { tags, dropped } (dropped = tags inválidas, p/ métrica/log).
 */
export function validateFacetTags(facetName, rawTags) {
  const facet = facetByName(facetName);
  if (!facet) return { tags: [], dropped: [] };
  const out = [];
  const seen = new Set();
  const dropped = [];
  for (const raw of rawTags || []) {
    const norm = normalizeTag(facet, raw);
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

/** Monta { system, user } do agente de UMA faceta (vocabulário + regras + artigo recortado). */
export function buildFacetPrompt(facet, article) {
  const tax = getTaxonomy();
  const { name, min, max } = facet;
  const aliasLines = Object.entries(tax.aliases || {})
    .map(([k, v]) => `${k} -> ${v}`)
    .join('\n');
  const content = String(article.content || '').slice(0, CLASSIFY_MAX_CHARS);
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
