// CONGELADO de src/llm.js (etapas articleClean/articleReclean): cleanArticleContent.
// Saída = LISTA DE SPANS de sujeira (verbatim); a remoção era local (clean.js applyJunkSpans).
// Texto, json_schema e parse copiados VERBATIM (ver _shared.mjs → FROZEN_FROM). NÃO edite.
import { clampText, legacyRequest, parseWith, t } from './_shared.mjs';

export const cleanSchema = {
  type: 'object',
  properties: {
    title: { type: ['string', 'null'] },
    junk_spans: { type: 'array', items: { type: 'string' } },
    published_at: { type: ['string', 'null'] },
  },
  required: ['title', 'junk_spans', 'published_at'],
  additionalProperties: false,
};

// cleanZ sem zod: junk_spans com default [] (tolerante).
const CLEAN_SHAPE = {
  title: t.nullish(t.string()),
  junk_spans: t.withDefault(t.array(t.string()), () => []),
  published_at: t.nullish(t.string()),
};
export const parseClean = (raw, opts) => parseWith(CLEAN_SHAPE, raw, opts);

/**
 * cleanArticleContent({title, content, stage}) congelado. `stage` 'articleReclean' era o passe
 * FORTE do `ncrawl reclean` — mesmo texto, só o model/effort da etapa mudava.
 */
export function buildCleanArticleRequest({ title, content, stage = 'articleClean' }, opts = {}) {
  const clamp = (s) => clampText(s, opts.maxChars);
  return legacyRequest(
    {
      stage,
      schemaName: 'clean_article',
      schema: cleanSchema,
      parse: parseClean,
      system:
        'Você identifica sujeira de interface em texto extraído de páginas web. Você copia os trechos ' +
        'EXATAMENTE como aparecem (verbatim) — nunca resume nem reescreve. Responda apenas com JSON.',
      user:
        'O texto abaixo foi extraído de uma página web e pode conter SUJEIRA de interface misturada ao ' +
        'conteúdo real: menus, breadcrumbs, botões ("Subscribe", "Sign up", "Share"), contadores ' +
        '("stars", "downloads", "contributors"), navegação de repositório, banners de cookie/paywall, ' +
        'listas de "related posts", créditos de rodapé, links de navegação soltos.\n' +
        'Devolva {title, junk_spans, published_at}:\n' +
        '- junk_spans: os trechos de SUJEIRA copiados VERBATIM do texto (cada um contíguo, até ~300 ' +
        'caracteres; divida sujeira longa em vários spans). Lista vazia se o texto já estiver limpo. ' +
        'NUNCA inclua texto do conteúdo real.\n' +
        '- title: o título real limpo de sufixos de site ("… | npm Docs", "GitHub - x/y: …"), ou null p/ manter.\n' +
        '- published_at: data de publicação se aparecer no texto (ISO 8601), senão null.\n\n' +
        `TÍTULO ATUAL: ${title || '(sem título)'}\n\nTEXTO:\n${clamp(content)}`,
    },
    opts,
  );
}
