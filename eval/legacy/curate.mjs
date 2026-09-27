// CONGELADO de src/llm.js (etapa curate): curateRoundupItems + curateLeftoverLinks.
// Texto, json_schema e parse copiados VERBATIM (ver _shared.mjs → FROZEN_FROM). NÃO edite o
// texto: ele é o baseline DeepSeek; um prompt "melhorado" aqui invalida a comparação.
import { clampText, legacyRequest, parseWith, t } from './_shared.mjs';

export const CURATE_KINDS = new Set(['news', 'tool', 'release', 'sponsor', 'job', 'other']);

export const curateSchema = {
  type: 'object',
  properties: {
    issue_date: { type: ['string', 'null'], description: 'data de publicação da edição (ISO se possível)' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          kind: { type: 'string', description: 'news | tool | release | sponsor | job | other' },
          section: { type: ['string', 'null'] },
          blurb: { type: ['string', 'null'] },
        },
        required: ['url', 'title', 'kind', 'section', 'blurb'],
        additionalProperties: false,
      },
    },
  },
  required: ['issue_date', 'items'],
  additionalProperties: false,
};

// curateZ sem zod: kind desconhecido -> 'news' (clamp), items com default [] (tolerante).
const clampKind = (s) => (CURATE_KINDS.has(String(s).toLowerCase().trim()) ? String(s).toLowerCase().trim() : 'news');
const CURATE_SHAPE = {
  issue_date: t.nullish(t.string()),
  items: t.withDefault(
    t.array(
      t.object({
        url: t.string(),
        title: t.string(),
        kind: t.map(t.string(), clampKind),
        section: t.nullish(t.string()),
        blurb: t.nullish(t.string()),
      }),
    ),
    () => [],
  ),
};
export const parseCurated = (raw, opts) => parseWith(CURATE_SHAPE, raw, opts);

export function sectionHint(section) {
  if (!section) return '';
  const s = String(section).toLowerCase();
  let tip = '';
  if (/release|version|changelog/.test(s)) tip = 'Tende a ser kind "release" (novas versões de libs/ferramentas).';
  else if (/tool|code/.test(s)) tip = 'Tende a ser kind "tool" (bibliotecas/ferramentas/serviços a usar).';
  else if (/brief|news|elsewhere|other news|community/.test(s)) tip = 'Tende a ser kind "news" (notícias curtas).';
  else if (/classified|job/.test(s)) tip = 'Tende a ser kind "job" (vagas/classificados) — normalmente NÃO se salva.';
  else if (/sponsor/.test(s)) tip = 'Tende a ser kind "sponsor" (anúncio pago) — NÃO se salva.';
  return `Esta parte é a seção «${section}» da edição. ${tip}`.trim();
}

/** curateRoundupItems({markdown, baseUrl, section, part}) congelado. */
export function buildCurateRoundupRequest({ markdown, baseUrl, section = null, part = null }, opts = {}) {
  const clamp = (s) => clampText(s, opts.maxChars);
  const hint = sectionHint(section);
  return legacyRequest(
    {
      stage: 'curate',
      schemaName: 'curated_items',
      schema: curateSchema,
      parse: parseCurated,
      system:
        'Você é o curador de uma edição de newsletter agregadora. Extrai CADA item curado com fidelidade ' +
        'total ao texto do agregador. Responda apenas com JSON.',
      user:
        `Edição/roundup de newsletter (URL ${baseUrl}${part ? `, parte ${part}` : ''}) em markdown. ` +
        (hint ? `${hint}\n` : '') +
        'Extraia TODOS os itens curados como {issue_date, items:[{url,title,kind,section,blurb}]}.\n' +
        (section ? `Use "${section}" como section dos itens desta parte, salvo se o texto indicar outra.\n` : '') +
        'REGRAS:\n' +
        '- Um item = uma notícia/ferramenta/release apresentada pela edição. Uma edição típica tem 15–25 ' +
        'itens: TODOS os DESTAQUES do topo (cada bloco título+comentário é um item — não pule os vizinhos ' +
        'de um patrocínio) E os de UMA LINHA (listas rápidas tipo "IN BRIEF" e listas de releases — cada ' +
        'linha com link próprio é um item).\n' +
        '- url: o link PRINCIPAL do item (a fonte externa). Links secundários dentro do comentário ' +
        '(documentação, "more info", release notes complementares) NÃO são itens separados.\n' +
        '- title: o título dado pelo AGREGADOR (ex.: "Node-GTK 4.0: GTK Bindings for Node"), não o da página alvo.\n' +
        '- kind: "news" (notícia/artigo/tutorial/opinião), "tool" (biblioteca/ferramenta/framework/serviço ' +
        'apresentado como coisa a usar), "release" (anúncio de NOVA VERSÃO, ex.: "Fastify 5.9"), ' +
        '"sponsor" (patrocínio/anúncio pago — geralmente marcado "sponsor"), "job" (vaga/classificado), ' +
        '"other" (navegação/social/interno/assinatura).\n' +
        '- section: o nome da seção da edição em que o item aparece (ex.: "Code & Tools", "Releases", ' +
        '"In Brief"), ou null.\n' +
        '- blurb: a descrição/comentário DO PRÓPRIO agregador sobre o item, em texto corrido limpo ' +
        '(sem markdown, sem emojis de seção, sem créditos de autor soltos), ou null se não houver.\n' +
        '- issue_date: a data de publicação da edição, se visível (ex.: "#631 — July 2, 2026" -> "2026-07-02").\n\n' +
        `MARKDOWN DA EDIÇÃO:\n${clamp(markdown)}`,
    },
    opts,
  );
}

/** curateLeftoverLinks({pageContext, baseUrl, leftovers:[{url, anchor}]}) congelado (passe de cobertura). */
export function buildCurateLeftoverRequest({ pageContext, baseUrl, leftovers }, opts = {}) {
  const clamp = (s) => clampText(s, opts.maxChars);
  const list = leftovers
    .map((l) => `- ${l.url}${l.anchor ? ` (âncora: ${JSON.stringify(l.anchor.slice(0, 80))})` : ''}`)
    .join('\n');
  return legacyRequest(
    {
      stage: 'curate',
      schemaName: 'curated_items',
      schema: curateSchema,
      parse: parseCurated,
      system:
        'Você é o curador de uma edição de newsletter agregadora, fazendo o passe de COBERTURA: ' +
        'classificar links que ficaram fora da primeira extração. Responda apenas com JSON.',
      user:
        `Edição de newsletter (URL ${baseUrl}): abaixo vai o HTML PODADO da página INTEIRA — ele ` +
        'INCLUI blocos que o extrator de corpo pode ter descartado (ex.: destaques vizinhos de ' +
        'anúncio); procure o bloco de cada link NELE. Depois vêm os LINKS que ficaram FORA da ' +
        'curadoria. Para CADA link listado, devolva um item {url,title,kind,section,blurb}:\n' +
        '- Se o link tem um BLOCO PRÓPRIO na edição (título/manchete + comentário do agregador — típico ' +
        'dos destaques do topo), ele é um ITEM REAL que faltou: use kind news|tool|release e COPIE o ' +
        'título e o comentário (blurb) do agregador. Na dúvida entre item real e secundário, se o link ' +
        'tem manchete própria, é item real.\n' +
        '- Se é link SECUNDÁRIO (aparece dentro do comentário de OUTRO item: documentação, "more info", ' +
        'release notes complementares, demo, o site do projeto citado de passagem), navegação, social ou ' +
        'assinatura, use kind "other". Um item REAL tem título próprio dado pelo agregador E comentário ' +
        'próprio; âncora genérica ("Demo", "Release notes", nome solto citado no meio do blurb de outro ' +
        'item) é SEMPRE "other".\n' +
        '- Se é patrocínio/anúncio pago, kind "sponsor"; vaga/classificado, kind "job".\n' +
        'Devolva um item por link listado (issue_date pode ser null).\n\n' +
        `LINKS FORA DA CURADORIA:\n${list}\n\nHTML PODADO DA PÁGINA INTEIRA:\n${clamp(pageContext)}`,
    },
    opts,
  );
}
