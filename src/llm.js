// Cliente OpenRouter (SDK openai) + derivação de seletores e fallbacks.
// Estratégia dois níveis: Pro (xhigh) deriva seletor reutilizável; Flash (high) faz fallbacks.
import OpenAI from 'openai';
import { z } from 'zod';
import {
  OPENROUTER_API_KEY, MODELS, HTTP_REFERER, X_TITLE, HAS_LLM, MAX_HTML_FOR_LLM,
} from './config.js';

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
// para DeepSeek V4 o efeito máximo é "xhigh" — "max" é rejeitado com 400.
async function callJSON({ model, reasoning, schema, schemaName, system, user }) {
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

// ---------- Pro (xhigh): seletor de links da listagem ----------
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
const linkSelectorZ = z.object({
  selector: z.string().min(1),
  attribute: z.string().min(1),
  confidence: z.number(),
});
export async function deriveLinkSelector(prunedHtml) {
  const out = await callJSON({
    model: MODELS.pro,
    reasoning: { effort: 'xhigh' },
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

// ---------- Pro (xhigh): seletor de conteúdo do artigo ----------
const contentSelectorSchema = {
  type: 'object',
  properties: {
    content_selector: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['content_selector', 'confidence'],
  additionalProperties: false,
};
const contentSelectorZ = z.object({ content_selector: z.string().min(1), confidence: z.number() });
export async function deriveContentSelector(prunedHtml) {
  const out = await callJSON({
    model: MODELS.pro,
    reasoning: { effort: 'xhigh' },
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

// ---------- Flash (high): próxima página ----------
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
  const out = await callJSON({
    model: MODELS.flash,
    reasoning: { effort: 'high' },
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

// ---------- Flash (high): extração de links item-a-item ----------
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
  const out = await callJSON({
    model: MODELS.flash,
    reasoning: { effort: 'high' },
    schemaName: 'links',
    schema: linksSchema,
    system: 'Você extrai links de artigos. Responda apenas com JSON.',
    user:
      'Extraia todos os links de artigos/edições individuais deste HTML como {links:[{url,title}]} ' +
      `(ignore menus, paginação, social).\n\nHTML:\n${clamp(prunedHtml)}`,
  });
  return linksZ.parse(out).links;
}

// ---------- Flash (high): extração de artigo ----------
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
  const out = await callJSON({
    model: MODELS.flash,
    reasoning: { effort: 'high' },
    schemaName: 'article',
    schema: articleSchema,
    system: 'Você extrai o conteúdo principal de um artigo. Responda apenas com JSON.',
    user:
      'Extraia o título, o corpo do artigo em texto limpo (sem menus/rodapé/relacionados) e a data ' +
      `de publicação (ISO 8601 ou null) deste conteúdo:\n\n${clamp(prunedHtmlOrText)}`,
  });
  return articleZ.parse(out);
}
