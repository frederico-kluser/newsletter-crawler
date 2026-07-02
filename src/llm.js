// Cliente OpenRouter (SDK openai) + derivação de seletores, fallbacks e classificação.
// Modelo + reasoning effort de CADA etapa vêm de stageModel() (config/models.json + env);
// default de tudo: deepseek/deepseek-v4-pro + xhigh ("max" => 400, então o teto é xhigh).
import OpenAI from 'openai';
import { z } from 'zod';
import {
  OPENROUTER_API_KEY, HTTP_REFERER, X_TITLE, HAS_LLM, MAX_HTML_FOR_LLM, SEARCH_MAX_CHARS,
  MODELS, stageModel, classifyFacetModel, LLM_TIMEOUT_MS,
} from './config.js';
import { getLane, reportRateLimit } from './governor.js';
import { reserve as budgetReserve } from './budget.js';
import { warn, sleep } from './util.js';

let _client = null;
function client() {
  if (!HAS_LLM) throw new Error('OPENROUTER_API_KEY ausente: caminho LLM indisponível');
  if (!_client) {
    _client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: OPENROUTER_API_KEY,
      defaultHeaders: { 'HTTP-Referer': HTTP_REFERER, 'X-Title': X_TITLE },
      // maxRetries 1 + timeout curto: o default do SDK (3 retries × 10 min, timeouts
      // re-tentados) deixaria uma chamada pendurada segurar um slot da lane por até 40 min.
      // 429/5xx pontuais ainda têm 1 retry interno; tempestades de 429 são tratadas pelo
      // gate de penalidade abaixo (que também recua a lane llm no governador).
      maxRetries: 1,
      timeout: LLM_TIMEOUT_MS,
    });
  }
  return _client;
}

// ---- transporte: 1 tentativa PAGA = lane llm -> penalidade 429 -> reserva -> create ----
// A penalidade de 429 é um timestamp COMPARTILHADO: um 429 de qualquer chamada segura TODAS
// as admissões novas (retry-after do provedor ou backoff exponencial, teto 60s), enquanto o
// governador halva a lane llm (recupera +1/10s limpo). Sem token bucket: o 429 é o sinal-verdade.
let _penaltyUntil = 0;
let _penaltyK = 0;

function retryAfterMsOf(err) {
  const h = err?.headers;
  const get = (k) => (typeof h?.get === 'function' ? h.get(k) : h?.[k]);
  const ms = Number(get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const s = Number(get('retry-after'));
  return Number.isFinite(s) && s > 0 ? s * 1000 : 0;
}

async function awaitPenalty() {
  for (;;) {
    const waitMs = _penaltyUntil - Date.now();
    if (waitMs <= 0) return;
    await sleep(Math.min(waitMs, 5000)); // re-checa: a janela pode ter sido estendida por outro 429
  }
}

function bumpPenalty(err) {
  _penaltyK = Math.min(_penaltyK + 1, 6);
  const backoff = Math.min(2 ** _penaltyK * 1000 * (0.5 + Math.random()), 60_000);
  const until = Date.now() + Math.max(retryAfterMsOf(err), backoff);
  if (until > _penaltyUntil) _penaltyUntil = until;
  reportRateLimit();
}

async function createOnce({ stage, model, reasoning, response_format, messages }) {
  return getLane('llm')(async () => {
    await awaitPenalty();
    const resv = budgetReserve(stage, model); // lança BudgetExceededError quando esgotado
    try {
      const resp = await client().chat.completions.create({
        model,
        reasoning,
        response_format,
        messages,
        // OpenRouter usage accounting: a resposta traz usage.cost (USD) — o custo REAL que
        // alimenta o ledger/orçamento. Passa pelo SDK como campo extra, igual ao `reasoning`.
        usage: { include: true },
      });
      // Commit ANTES do parse de JSON: um 200 malformado também custou dinheiro.
      resv.commit({ model: resp.model || model, usage: resp.usage });
      if (Date.now() >= _penaltyUntil) _penaltyK = 0; // janela limpa: zera o backoff
      return resp;
    } catch (e) {
      resv.cancel(); // falha de transporte não é cobrada; devolve a reserva
      throw e;
    }
  });
}

async function createWithRateLimitRetry(args) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await createOnce(args);
    } catch (e) {
      if (e?.status === 429 && attempt < 3) {
        bumpPenalty(e);
        warn(`429 do OpenRouter (${args.stage}); aguardando a janela de penalidade…`);
        continue; // re-admite pela lane e espera a penalidade
      }
      throw e;
    }
  }
}

const responseFormat = (name, schema) => ({
  type: 'json_schema',
  json_schema: { name, strict: true, schema },
});

// IMPORTANTE: enviar SÓ o objeto aninhado `reasoning` (nunca `reasoning_effort` junto);
// para DeepSeek V4 o efeito máximo é "xhigh" — "max" é rejeitado com 400 (guard abaixo).
// Parse defensivo: JSON direto -> extrai o {...} -> undefined (sentinela; JSON.parse nunca
// devolve undefined, então é seguro distinguir "falhou" de um valor válido como null/false).
function tryParseJSON(content) {
  if (!content) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    /* tenta extrair o objeto */
  }
  const m = content.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      /* desiste */
    }
  }
  return undefined;
}

let _warnedMaxEffort = false;
// Exportado para o harness de avaliação (eval/) reusar EXATAMENTE o mesmo caminho de chamada
// (reasoning-only, guard de 'max', retry de JSON). Passe fallbackModel:null p/ isolar o modelo.
export async function callJSON({
  model, reasoning, schema, schemaName, system, user, retries = 2, fallbackModel = MODELS.pro,
  stage = 'other', // rótulo do estágio p/ o ledger de custo (default p/ usos avulsos/eval)
}) {
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
  const response_format = responseFormat(schemaName, schema);

  // Retry no JSON inválido: o Flash às vezes trunca/malforma a resposta (esp. com reasoning alto).
  // Estratégia: até `retries+1` tentativas re-amostrando o MESMO modelo (a chamada não é
  // temperatura 0, então uma nova amostra costuma resolver); na ÚLTIMA tentativa, se o modelo é
  // Flash, escala p/ o Pro (`fallbackModel`), que é mais confiável no JSON. maxRetries do SDK já
  // cobre 429/5xx; aqui cobrimos resposta 200 com conteúdo não-parseável.
  for (let attempt = 0; ; attempt++) {
    const isLast = attempt >= retries;
    const useModel = isLast && fallbackModel && model !== fallbackModel ? fallbackModel : model;
    // Cada tentativa (inclusive a escalada p/ o Pro) é uma admissão própria no transporte:
    // lane llm + reserva de orçamento com o modelo certo + registro do custo real.
    const resp = await createWithRateLimitRetry({
      stage, model: useModel, reasoning, response_format, messages,
    });
    const parsed = tryParseJSON(resp.choices?.[0]?.message?.content ?? '');
    if (parsed !== undefined) return parsed;
    if (isLast) throw new Error('JSON inválido retornado pelo LLM');
    const next = attempt + 1 >= retries && fallbackModel && model !== fallbackModel ? fallbackModel : model;
    warn(`JSON inválido do LLM (tentativa ${attempt + 1}/${retries + 1}); repetindo com ${next}…`);
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
    stage: 'linkSelector',
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
    stage: 'contentSelector',
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
    stage: 'nextLink',
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
    stage: 'linkExtract',
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
    stage: 'roundupExtract',
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
    stage: 'articleExtract',
    schemaName: 'article',
    schema: articleSchema,
    system: 'Você extrai o conteúdo principal de um artigo. Responda apenas com JSON.',
    user:
      'Extraia o título, o corpo do artigo em texto limpo (sem menus/rodapé/relacionados) e a data ' +
      `de publicação (ISO 8601 ou null) deste conteúdo:\n\n${clamp(prunedHtmlOrText)}`,
  });
  return articleZ.parse(out);
}

// ---------- etapa curate: itens estruturados de uma issue/roundup (Flash, chunks paralelos) ----------
// O agregador é a FONTE DA VERDADE do item: título curado, blurb (a descrição da própria
// newsletter — muitas vezes a única informação boa sobre uma ferramenta) e o tipo. Sem enum
// no json_schema (strict não é garantia); o clamp fica no zod (desconhecido -> 'news',
// fail-open p/ salvar — o backstop determinístico de sponsor fica em curate.js).
export const CURATE_KINDS = new Set(['news', 'tool', 'release', 'sponsor', 'job', 'other']);
const curateSchema = {
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
const curateZ = z.object({
  issue_date: z.string().nullish(),
  items: z.array(
    z.object({
      url: z.string(),
      title: z.string(),
      kind: z
        .string()
        .transform((s) => (CURATE_KINDS.has(String(s).toLowerCase().trim()) ? String(s).toLowerCase().trim() : 'news')),
      section: z.string().nullish(),
      blurb: z.string().nullish(),
    }),
  ),
});
// Hint por SEÇÃO: o tipo de conteúdo mais provável de cada seção, p/ o agente especializar o
// kind. É só um viés (o agente decide item a item), não uma regra dura.
function sectionHint(section) {
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

export async function curateRoundupItems({ markdown, baseUrl, section = null, part = null }) {
  const { model, effort } = stageModel('curate');
  const hint = sectionHint(section);
  const out = await callJSON({
    model,
    reasoning: { effort },
    stage: 'curate',
    schemaName: 'curated_items',
    schema: curateSchema,
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
  });
  return curateZ.parse(out);
}

// Passe de COBERTURA da curadoria: o curador pode omitir itens (recall imperfeito); a
// diferença determinística de conjuntos (links do corpo − itens emitidos) chega aqui, e um
// agente decide o que é item real que FALTOU vs link secundário/patrocínio. Mesmo schema.
export async function curateLeftoverLinks({ pageContext, baseUrl, leftovers }) {
  const { model, effort } = stageModel('curate');
  const list = leftovers
    .map((l) => `- ${l.url}${l.anchor ? ` (âncora: ${JSON.stringify(l.anchor.slice(0, 80))})` : ''}`)
    .join('\n');
  const out = await callJSON({
    model,
    reasoning: { effort },
    stage: 'curate',
    schemaName: 'curated_items',
    schema: curateSchema,
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
  });
  return curateZ.parse(out);
}

// ---------- etapa articleClean: limpeza do conteúdo extraído antes de salvar (Flash) ----------
// Saída = LISTA DE SPANS de sujeira a remover (verbatim), NÃO o texto reescrito: a remoção
// acontece localmente (clean.js applyJunkSpans), o que torna a saída ~100x menor (rápida, sem
// risco de truncamento/alucinação — só se DELETA texto, nunca se reescreve).
const cleanSchema = {
  type: 'object',
  properties: {
    title: { type: ['string', 'null'] },
    junk_spans: { type: 'array', items: { type: 'string' } },
    published_at: { type: ['string', 'null'] },
  },
  required: ['title', 'junk_spans', 'published_at'],
  additionalProperties: false,
};
const cleanZ = z.object({
  title: z.string().nullish(),
  junk_spans: z.array(z.string()),
  published_at: z.string().nullish(),
});
export async function cleanArticleContent({ title, content, stage = 'articleClean' }) {
  const { model, effort } = stageModel(stage);
  const out = await callJSON({
    model,
    reasoning: { effort },
    stage,
    schemaName: 'clean_article',
    schema: cleanSchema,
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
  });
  return cleanZ.parse(out);
}

// ---------- etapa verifyRecord: verificação pós-cadastro (Flash, varredura paralela) ----------
const VERIFY_VERDICTS = new Set(['ok', 'suspect', 'junk']);
const verifySchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', description: 'ok | suspect | junk' },
    problems: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'problems'],
  additionalProperties: false,
};
const verifyZ = z.object({
  verdict: z
    .string()
    .transform((s) => (VERIFY_VERDICTS.has(String(s).toLowerCase().trim()) ? String(s).toLowerCase().trim() : 'suspect')),
  problems: z.array(z.string()),
});
export async function verifyRecordLLM({ url, kind, title, blurb, content }) {
  const { model, effort } = stageModel('verifyRecord');
  const out = await callJSON({
    model,
    reasoning: { effort },
    stage: 'verifyRecord',
    schemaName: 'verify_record',
    schema: verifySchema,
    system:
      'Você audita registros salvos por um crawler de newsletters. Seja rigoroso e específico. ' +
      'Responda apenas com JSON.',
    user:
      'Avalie o REGISTRO salvo abaixo e devolva {verdict, problems}.\n' +
      'verdict:\n' +
      '- "ok": registro limpo e coerente (título condiz com o conteúdo; conteúdo é texto real e legível).\n' +
      '- "suspect": utilizável, mas com problemas (restos de interface/menu/marketing no conteúdo, título ' +
      'sujo, conteúdo raso demais p/ o título, kind aparentemente errado). Liste-os em problems.\n' +
      '- "junk": não é conteúdo real (página de erro/bloqueio/captcha, só navegação, propaganda pura, ' +
      'stub de paywall, texto ilegível).\n' +
      'problems: lista curta e específica em PT-BR (vazia se ok).\n\n' +
      `REGISTRO\nurl: ${url}\nkind: ${kind || '(sem kind)'}\ntítulo: ${title || '(vazio)'}\n` +
      `blurb do agregador: ${blurb || '(nenhum)'}\n\nconteúdo (recorte):\n${clamp(content)}`,
  });
  return verifyZ.parse(out);
}

// ---------- etapa dateSelector: seletor de DATA da listagem (CSS + regex) lendo a página real ----------
// Gerado POR template de weekly quando o layout não expõe <time datetime> nem classe de data
// reconhecível; o chamador VALIDA contra a própria página antes de cachear (self-healing).
const dateSelectorSchema = {
  type: 'object',
  properties: {
    date_selector: { type: ['string', 'null'], description: 'seletor CSS do elemento que carrega a data do item' },
    date_attribute: { type: ['string', 'null'], description: 'atributo com a data (ex.: datetime, content) ou null p/ texto' },
    date_regex: { type: ['string', 'null'], description: 'regex JS que captura a data (grupo 1) do texto/atributo' },
    confidence: { type: 'number' },
  },
  required: ['date_selector', 'date_attribute', 'date_regex', 'confidence'],
  additionalProperties: false,
};
const dateSelectorZ = z.object({
  date_selector: z.string().nullish(),
  date_attribute: z.string().nullish(),
  date_regex: z.string().nullish(),
  confidence: z.number().nullish(),
});
export async function deriveDateSelector(prunedHtml, baseUrl) {
  const { model, effort } = stageModel('dateSelector');
  const out = await callJSON({
    model,
    reasoning: { effort },
    stage: 'dateSelector',
    schemaName: 'date_selector',
    schema: dateSelectorSchema,
    system:
      'Você é um especialista em CSS, regex e web scraping. Você lê o HTML REAL e devolve seletores ' +
      'que funcionam nesta página específica. Responda apenas com JSON.',
    user:
      `Página de arquivo/listagem de newsletter (URL ${baseUrl}). Cada item da lista aponta p/ uma ` +
      'edição/artigo e tem uma DATA associada (no próprio item). Devolva como extrair essa data de ' +
      'CADA item: {date_selector, date_attribute, date_regex, confidence}.\n' +
      '- date_selector: seletor CSS do elemento da data DENTRO do container do item (ex.: ".issue-date", ' +
      '"time", "span.meta"). Deve casar 1 elemento por item, não um global da página.\n' +
      '- date_attribute: atributo que carrega a data (ex.: "datetime", "content"), ou null se a data é o TEXTO.\n' +
      '- date_regex: regex JavaScript (sem flags) que captura a data no grupo 1 a partir do texto/atributo ' +
      '(ex.: "(\\\\d{4}-\\\\d{2}-\\\\d{2})"), ou null se o valor inteiro já é a data.\n' +
      'Se a página realmente não tiver data por item, devolva tudo null com confidence baixa.\n\n' +
      `HTML (podado):\n${clamp(prunedHtml)}`,
  });
  return dateSelectorZ.parse(out);
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
export async function classifyFacet({ facet, system, user }) {
  // Modelo POR FACETA: facetas de baixo valor caem p/ Flash (models.json), o resto segue Pro.
  const { model, effort } = facet ? classifyFacetModel(facet) : stageModel('classify');
  const out = await callJSON({
    model,
    reasoning: { effort }, // default 'xhigh' = teto real do DeepSeek V4 ("max" => 400)
    stage: 'classify', // ledger/eventos agregam sob 'classify' (o EMA de custo é por stage:model)

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
    stage: 'summarize',
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
export const relevanceSchema = {
  type: 'object',
  properties: {
    relation: { type: 'string', description: 'direct | similar | none' },
    kind: { type: 'string', description: 'news | tool' },
  },
  required: ['relation', 'kind'],
  additionalProperties: false,
};
// Sem enum no json_schema (strict não garante); a garantia real é o clamp do zod + fail-open.
export const relevanceZ = z.object({
  relation: z.string().transform((s) => (RELATIONS.has(String(s).toLowerCase()) ? String(s).toLowerCase() : 'none')),
  kind: z.string().transform((s) => (KINDS.has(String(s).toLowerCase()) ? String(s).toLowerCase() : 'news')),
});
export async function judgeRelevance({ query, title, content }) {
  const { model, effort } = stageModel('searchRelevance');
  const out = await callJSON({
    model,
    reasoning: { effort },
    stage: 'searchRelevance',
    schemaName: 'relevance',
    schema: relevanceSchema,
    // Prompt escolhido por avaliação (eval/): variante "v2_fewshot" — rubrica + few-shot contrastivo.
    // 3 rodadas × 5 cenários × 36 artigos, gabarito Opus: F1 macro Flash 0.848 vs baseline 0.731
    // (+0.117; precisão 0.59→0.79, corta falsos positivos), Pro 0.807 vs 0.778. Mesma latência, 0 falhas JSON.
    system:
      'Você é um avaliador de relevância de busca, rigoroso e consistente. Siga a rubrica e os EXEMPLOS. ' +
      'Responda APENAS com JSON válido.',
    user:
      'RUBRICA relation: "direct"=foco central da consulta; "similar"=adjacente, não é o foco; "none"=sem resposta. ' +
      'Mesmo tema amplo NÃO basta para "direct". kind: "tool"=sobre biblioteca/pacote/framework/CLI; senão "news".\n\n' +
      'EXEMPLOS (consulta → artigo → saída):\n' +
      '1) "bibliotecas de inferência de LLM" → "Lib X acelera serving de LLM em GPU" → {"relation":"direct","kind":"tool"}\n' +
      '2) "bibliotecas de inferência de LLM" → "Startup de IA capta US$ 300M" → {"relation":"none","kind":"news"}\n' +
      '3) "captação de startups de IA" → "Paper novo sobre compressão de KV cache" → {"relation":"none","kind":"news"}\n' +
      '4) "regulação de IA" → "UE atrasa provisões do AI Act" → {"relation":"direct","kind":"news"}\n' +
      '5) "modelos de pesos abertos" → "Modelo PROPRIETÁRIO Y desafia rivais" → {"relation":"none","kind":"news"}\n\n' +
      `CONSULTA: ${query}\n\n` +
      `ARTIGO\nTítulo: ${title || ''}\n\nConteúdo:\n${String(content || '').slice(0, SEARCH_MAX_CHARS)}\n\n` +
      'Devolva JSON {"relation","kind"}.',
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
    stage: 'searchTags',
    schemaName: 'search_tags',
    schema: searchTagsSchema,
    system,
    user,
  });
  return searchTagsZ.parse(out).tags;
}
