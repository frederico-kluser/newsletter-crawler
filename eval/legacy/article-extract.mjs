// CONGELADO de src/llm.js (etapa articleExtract): extractArticleViaLLM (fallback de extração).
// Texto, json_schema e parse copiados VERBATIM (ver _shared.mjs → FROZEN_FROM). NÃO edite.
import { clampText, legacyRequest, parseWith, t } from './_shared.mjs';

export const articleSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    content: { type: 'string' },
    published_at: { type: ['string', 'null'] },
  },
  required: ['title', 'content', 'published_at'],
  additionalProperties: false,
};

// articleZ sem zod: published_at é nullable (null ok; AUSENTE = fora do schema).
const ARTICLE_SHAPE = {
  title: t.string(),
  content: t.string(),
  published_at: t.nullable(t.string()),
};
export const parseArticle = (raw, opts) => parseWith(ARTICLE_SHAPE, raw, opts);

/** extractArticleViaLLM(prunedHtmlOrText) congelado. */
export function buildExtractArticleRequest(prunedHtmlOrText, opts = {}) {
  const clamp = (s) => clampText(s, opts.maxChars);
  return legacyRequest(
    {
      stage: 'articleExtract',
      schemaName: 'article',
      schema: articleSchema,
      parse: parseArticle,
      system: 'Você extrai o conteúdo principal de um artigo. Responda apenas com JSON.',
      user:
        'Extraia o título, o corpo do artigo em texto limpo (sem menus/rodapé/relacionados) e a data ' +
        `de publicação (ISO 8601 ou null) deste conteúdo:\n\n${clamp(prunedHtmlOrText)}`,
    },
    opts,
  );
}
