// Cliente OpenRouter (SDK openai) + derivação de seletores, fallbacks e classificação.
// Modelo + reasoning effort de CADA etapa vêm de stageModel() (config/models.json + env);
// default de tudo: deepseek/deepseek-v4-pro + xhigh ("max" => 400, então o teto é xhigh).
import OpenAI from 'openai';
import { z } from 'zod';
import {
  OPENROUTER_API_KEY, HTTP_REFERER, X_TITLE, HAS_LLM, MAX_HTML_FOR_LLM, SEARCH_MAX_CHARS, stageModel,
} from './config.js';
import { warn } from './util.js';

let _client = null;
function client() {
  if (!HAS_LLM) throw new Error('OPENROUTER_API_KEY ausente: caminho LLM indisponível');
  if (!_client) {
    _client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: OPENROUTER_API_KEY,
      defaultHeaders: { 'HTTP-Referer': HTTP_REFERER, 'X-Title': X_TITLE },
      maxRetries: 3, // cobre 429/5xx automaticamente
    });
  }
  return _client;
}

const responseFormat = (name, schema) => ({
  type: 'json_schema',
  json_schema: { name, strict: true, schema },
});

// IMPORTANTE: enviar SÓ o objeto aninhado `reasoning` (nunca `reasoning_effort` junto);
// para DeepSeek V4 o efeito máximo é "xhigh" — "max" é rejeitado com 400 (guard abaixo).
let _warnedMaxEffort = false;
async function callJSON({ model, reasoning, schema, schemaName, system, user }) {
  // Guard: "max" não é suportado pelo DeepSeek V4 (HTTP 400); rebaixa para "xhigh".
  if (reasoning?.effort === 'max') {
    if (!_warnedMaxEffort) {
      warn("reasoning effort 'max' não é suportado pelo DeepSeek V4 (HTTP 400); usando 'xhigh'.");
      _warnedMaxEffort = true;
    }
    reasoning = { ...reasoning, effort: 'xhigh' };
  }

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  const resp = await client().chat.completions.create({
    model,
    reasoning,
    response_format: responseFormat(schemaName, schema),
    messages,
  });

  const content = resp.choices?.[0]?.message?.content ?? '';
  // Parser defensivo mesmo com strict:true.
  try {
    return JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* cai no throw */
      }
    }
    throw new Error('JSON inválido retornado pelo LLM');
  }
}

const clamp = (s) => (s || '').slice(0, MAX_HTML_FOR_LLM);

// ---------- etapa linkSelector: seletor de links da listagem ----------
const linkSelectorSchema = {
  type: 'object',
  properties: {
    selector: { type: 'string', description: 'seletor CSS para os <a> de artigos individuais' },
    attribute: { type: 'string', description: 'atributo do link, normalmente href' },
    confidence: { type: 'number' },
  },
  required: ['selector', 'attribute', 'confidence'],
  additionalProperties: false,
};
// `confidence`/`attribute` são tolerantes: o DeepSeek às vezes omite campos mesmo com
// strict:true ("strict não é garantia absoluta"). Não derrubamos a derivação por metadado.
const linkSelectorZ = z.object({
  selector: z.string().min(1),
  attribute: z.string().nullish(),
  confidence: z.number().nullish(),
});
export async function deriveLinkSelector(prunedHtml) {
  const { model, effort } = stageModel('linkSelector');
  const out = await callJSON({
    model,
    reasoning: { effort },
    schemaName: 'link_selector',
    schema: linkSelectorSchema,
    system: 'Você é um especialista em CSS e web scraping. Responda apenas com JSON.',
    user:
      'Dado este HTML (podado) de uma página de arquivo/listagem de uma newsletter, retorne um ' +
      'seletor CSS que selecione SOMENTE os elementos <a> que apontam para artigos/edições ' +
      'individuais (ignore menus, paginação, tags, social, autor). Prefira um seletor estável e ' +
      `específico, e informe o atributo do link.\n\nHTML:\n${clamp(prunedHtml)}`,
  });
  return linkSelectorZ.parse(out);
}

// ---------- etapa contentSelector: seletor de conteúdo do artigo ----------
const contentSelectorSchema = {
  type: 'object',
  properties: {
    content_selector: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['content_selector', 'confidence'],
  additionalProperties: false,
};
const contentSelectorZ = z.object({
  content_selector: z.string().min(1),
  confidence: z.number().nullish(),
});
export async function deriveContentSelector(prunedHtml) {
  const { model, effort } = stageModel('contentSelector');
  const out = await callJSON({
    model,
    reasoning: { effort },
    schemaName: 'content_selector',
    schema: contentSelectorSchema,
    system: 'Você é um especialista em CSS e web scraping. Responda apenas com JSON.',
    user:
      'Dado este HTML (podado) de uma PÁGINA DE ARTIGO de newsletter, retorne um seletor CSS para ' +
      'o container do CORPO do artigo (o texto principal, sem menus/rodapé/relacionados).\n\n' +
      `HTML:\n${clamp(prunedHtml)}`,
  });
  return contentSelectorZ.parse(out);
}

// ---------- etapa nextLink: próxima página (paginação) ----------
const nextSchema = {
  type: 'object',
  properties: {
    next_url: { type: ['string', 'null'] },
    selector: { type: ['string', 'null'] },
  },
  required: ['next_url', 'selector'],
  additionalProperties: false,
};
const nextZ = z.object({ next_url: z.string().nullable(), selector: z.string().nullable() });
export async function deriveNextLink(prunedHtml, baseUrl) {
  const { model, effort } = stageModel('nextLink');
  const out = await callJSON({
    model,
    reasoning: { effort },
    schemaName: 'next_link',
    schema: nextSchema,
    system: 'Você localiza o link de próxima página de listagens. Responda apenas com JSON.',
    user:
      `Nesta página de listagem (URL base ${baseUrl}), qual é a URL da PRÓXIMA página de arquivo ` +
      '(paginação, "mais antigos", "próximo")? Se não houver, next_url=null. Inclua também um ' +
      `seletor CSS do link, se possível.\n\nHTML:\n${clamp(prunedHtml)}`,
  });
  return nextZ.parse(out);
}

// ---------- etapa linkExtract: extração de links item-a-item (fallback) ----------
const linksSchema = {
  type: 'object',
  properties: {
    links: {
      type: 'array',
      items: {
        type: 'object',
        properties: { url: { type: 'string' }, title: { type: 'string' } },
        required: ['url', 'title'],
        additionalProperties: false,
      },
    },
  },
  required: ['links'],
  additionalProperties: false,
};
const linksZ = z.object({ links: z.array(z.object({ url: z.string(), title: z.string() })) });
export async function extractLinksItemByItem(prunedHtml) {
  const { model, effort } = stageModel('linkExtract');
  const out = await callJSON({
    model,
    reasoning: { effort },
    schemaName: 'links',
    schema: linksSchema,
    system: 'Você extrai links de artigos. Responda apenas com JSON.',
    user:
      'Extraia todos os links de artigos/edições individuais deste HTML como {links:[{url,title}]} ' +
      `(ignore menus, paginação, social).\n\nHTML:\n${clamp(prunedHtml)}`,
  });
  return linksZ.parse(out).links;
}

// ---------- etapa roundupExtract: links externos curados de uma issue/roundup (fallback) ----------
// Usado quando o Readability não isola os links da issue. Diferente de linkExtract: aqui os
// alvos são os links das FONTES EXTERNAS (a notícia em si), não edições internas da newsletter.
export async function extractRoundupLinks(prunedHtml, baseUrl) {
  const { model, effort } = stageModel('roundupExtract');
  const out = await callJSON({
    model,
    reasoning: { effort },
    schemaName: 'roundup_links',
    schema: linksSchema,
    system: 'Você extrai os links das fontes externas citadas numa edição de newsletter. Responda apenas com JSON.',
    user:
      `Esta é uma EDIÇÃO/ROUNDUP de newsletter (URL ${baseUrl}) com comentário editorial e links ` +
      'para NOTÍCIAS/ARTIGOS EXTERNOS. Extraia {links:[{url,title}]} com os links das fontes externas ' +
      '(a notícia em si). IGNORE: navegação do site, edição anterior/próxima, links internos da própria ' +
      'newsletter, social, login, e PATROCÍNIO/anúncio. Prefira URLs absolutas.\n\n' +
      `HTML:\n${clamp(prunedHtml)}`,
  });
  return linksZ.parse(out).links;
}

// ---------- etapa articleExtract: extração de artigo via LLM (fallback) ----------
const articleSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    content: { type: 'string' },
    published_at: { type: ['string', 'null'] },
  },
  required: ['title', 'content', 'published_at'],
  additionalProperties: false,
};
const articleZ = z.object({
  title: z.string(),
  content: z.string(),
  published_at: z.string().nullable(),
});
export async function extractArticleViaLLM(prunedHtmlOrText) {
  const { model, effort } = stageModel('articleExtract');
  const out = await callJSON({
    model,
    reasoning: { effort },
    schemaName: 'article',
    schema: articleSchema,
    system: 'Você extrai o conteúdo principal de um artigo. Responda apenas com JSON.',
    user:
      'Extraia o título, o corpo do artigo em texto limpo (sem menus/rodapé/relacionados) e a data ' +
      `de publicação (ISO 8601 ou null) deste conteúdo:\n\n${clamp(prunedHtmlOrText)}`,
  });
  return articleZ.parse(out);
}

// ---------- etapa classify: classificação multi-faceta (1 agente por faceta) ----------
// Schema/zod UNIFORMES: tags são strings simples — SEM enum no json_schema. O suporte a
// enum/minItems no strict do DeepSeek V4 não é comprovado; a garantia real de vocabulário é
// a validação por Set em taxonomy.js (no espírito "strict não é garantia absoluta"). O
// vocabulário, os limites e as regras vão no prompt (montado em taxonomy.js).
const facetSchema = {
  type: 'object',
  properties: {
    tags: { type: 'array', items: { type: 'string' } },
    uncovered: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['tags', 'uncovered', 'confidence'],
  additionalProperties: false,
};
const facetZ = z.object({
  tags: z.array(z.string()),
  uncovered: z.array(z.string()),
  confidence: z.number(),
});
export async function classifyFacet({ system, user }) {
  const { model, effort } = stageModel('classify');
  const out = await callJSON({
    model,
    reasoning: { effort }, // default 'xhigh' = teto real do DeepSeek V4 ("max" => 400)
    schemaName: 'facet_tags',
    schema: facetSchema,
    system,
    user,
  });
  return facetZ.parse(out);
}

// ---------- etapa summarize: título + resumo em PT-BR (Flash high) ----------
const summarySchema = {
  type: 'object',
  properties: { title_pt: { type: 'string' }, summary_pt: { type: 'string' } },
  required: ['title_pt', 'summary_pt'],
  additionalProperties: false,
};
const summaryZ = z.object({ title_pt: z.string(), summary_pt: z.string() });
export async function summarizeArticle({ title, content }) {
  const { model, effort } = stageModel('summarize');
  const out = await callJSON({
    model,
    reasoning: { effort },
    schemaName: 'summary_pt',
    schema: summarySchema,
    system:
      'Você é um editor técnico brasileiro. Resuma artigos de tecnologia em português do Brasil, ' +
      'de forma fiel e fluente. Responda apenas com JSON.',
    user:
      'Traduza o TÍTULO e escreva um RESUMO em português do Brasil do artigo abaixo.\n' +
      '- title_pt: o título adaptado para PT-BR (curto, natural).\n' +
      '- summary_pt: um resumo CLARO e LEGÍVEL em PT-BR (NÃO é tradução literal palavra-por-palavra). ' +
      'Cubra os pontos principais em 1–3 parágrafos curtos; preserve nomes próprios, termos técnicos e ' +
      'nomes de produtos/bibliotecas no original quando fizer sentido.\n' +
      'Devolva SOMENTE JSON {"title_pt","summary_pt"}.\n\n' +
      `ARTIGO\nTítulo: ${title || ''}\n\nConteúdo:\n${clamp(content)}`,
  });
  return summaryZ.parse(out);
}

// ---------- etapa searchRelevance: julga artigo vs consulta (modo A, Flash high, 50x) ----------
const RELATIONS = new Set(['direct', 'similar', 'none']);
const KINDS = new Set(['news', 'tool']);
const relevanceSchema = {
  type: 'object',
  properties: {
    relation: { type: 'string', description: 'direct | similar | none' },
    kind: { type: 'string', description: 'news | tool' },
  },
  required: ['relation', 'kind'],
  additionalProperties: false,
};
// Sem enum no json_schema (strict não garante); a garantia real é o clamp do zod + fail-open.
const relevanceZ = z.object({
  relation: z.string().transform((s) => (RELATIONS.has(String(s).toLowerCase()) ? String(s).toLowerCase() : 'none')),
  kind: z.string().transform((s) => (KINDS.has(String(s).toLowerCase()) ? String(s).toLowerCase() : 'news')),
});
export async function judgeRelevance({ query, title, content }) {
  const { model, effort } = stageModel('searchRelevance');
  const out = await callJSON({
    model,
    reasoning: { effort },
    schemaName: 'relevance',
    schema: relevanceSchema,
    system: 'Você avalia se um ARTIGO técnico é relevante para uma CONSULTA de busca. Responda apenas com JSON.',
    user:
      `CONSULTA: ${query}\n\n` +
      'Avalie o ARTIGO em relação à CONSULTA e devolva JSON {"relation","kind"}:\n' +
      '- relation: "direct" se o artigo trata DIRETAMENTE do que a consulta pede (é o foco); ' +
      '"similar" se é relacionado/adjacente mas não é o foco; "none" se não há relação real.\n' +
      '- kind: "tool" se o artigo é SOBRE uma ferramenta (pacote npm/biblioteca/framework/CLI e o que ' +
      'ela faz/como usar); "news" caso contrário (notícia, lançamento, análise, tutorial, opinião, paper...).\n\n' +
      `ARTIGO\nTítulo: ${title || ''}\n\nConteúdo:\n${String(content || '').slice(0, SEARCH_MAX_CHARS)}`,
  });
  return relevanceZ.parse(out);
}

// ---------- etapa searchTags: mapeia consulta -> tags de UMA faceta (modo B, Pro) ----------
const searchTagsSchema = {
  type: 'object',
  properties: { tags: { type: 'array', items: { type: 'string' } } },
  required: ['tags'],
  additionalProperties: false,
};
const searchTagsZ = z.object({ tags: z.array(z.string()) });
export async function mapQueryToFacetTags({ system, user }) {
  const { model, effort } = stageModel('searchTags');
  const out = await callJSON({
    model,
    reasoning: { effort },
    schemaName: 'search_tags',
    schema: searchTagsSchema,
    system,
    user,
  });
  return searchTagsZ.parse(out).tags;
}
