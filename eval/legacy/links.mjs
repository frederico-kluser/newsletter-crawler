// CONGELADO de src/llm.js (etapas linkExtract/roundupExtract): extractLinksItemByItem +
// extractRoundupLinks (os fallbacks de extração de links por LLM).
// Texto, json_schema e parse copiados VERBATIM (ver _shared.mjs → FROZEN_FROM). NÃO edite.
import { clampText, legacyRequest, parseWith, t } from './_shared.mjs';

export const linksSchema = {
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

// linksZ sem zod (sem default: links ausente/inválido = fora do schema).
const LINKS_SHAPE = { links: t.array(t.object({ url: t.string(), title: t.string() })) };
export const parseLinks = (raw, opts) => parseWith(LINKS_SHAPE, raw, opts);
// O que as funções originais DEVOLVIAM (`linksZ.parse(out).links`) — é o `req.parse` dos builders.
const parseLinksReturn = (raw, opts) => parseLinks(raw, opts)?.links ?? null;

/** extractLinksItemByItem(prunedHtml) congelado; req.parse devolve o array `links`, como o original. */
export function buildExtractLinksRequest(prunedHtml, opts = {}) {
  const clamp = (s) => clampText(s, opts.maxChars);
  return legacyRequest(
    {
      stage: 'linkExtract',
      schemaName: 'links',
      schema: linksSchema,
      parse: parseLinksReturn,
      system: 'Você extrai links de artigos. Responda apenas com JSON.',
      user:
        'Extraia todos os links de artigos/edições individuais deste HTML como {links:[{url,title}]} ' +
        `(ignore menus, paginação, social).\n\nHTML:\n${clamp(prunedHtml)}`,
    },
    opts,
  );
}

/** extractRoundupLinks(prunedHtml, baseUrl) congelado; req.parse devolve o array `links`. */
export function buildExtractRoundupLinksRequest(prunedHtml, baseUrl, opts = {}) {
  const clamp = (s) => clampText(s, opts.maxChars);
  return legacyRequest(
    {
      stage: 'roundupExtract',
      schemaName: 'roundup_links',
      schema: linksSchema,
      parse: parseLinksReturn,
      system: 'Você extrai os links das fontes externas citadas numa edição de newsletter. Responda apenas com JSON.',
      user:
        `Esta é uma EDIÇÃO/ROUNDUP de newsletter (URL ${baseUrl}) com comentário editorial e links ` +
        'para NOTÍCIAS/ARTIGOS EXTERNOS. Extraia {links:[{url,title}]} com os links das fontes externas ' +
        '(a notícia em si). IGNORE: navegação do site, edição anterior/próxima, links internos da própria ' +
        'newsletter, social, login, e PATROCÍNIO/anúncio. Prefira URLs absolutas.\n\n' +
        `HTML:\n${clamp(prunedHtml)}`,
    },
    opts,
  );
}
