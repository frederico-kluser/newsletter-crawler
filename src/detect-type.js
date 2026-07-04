// Detecção automática do TIPO de uma fonte (index | listing) na hora de adicioná-la, para o
// usuário não precisar saber a diferença. SEMPRE consulta a IA quando há chave (pedido do
// usuário), mas alimenta o modelo com SINAIS baratos e determinísticos da página (padrão da URL,
// links internos×externos, links que "parecem edição", tamanho da prosa) — evidência faz a IA
// acertar mais. Fail-open em CADA etapa: fetch/parse/IA falhou → cai na heurística (os mesmos
// sinais) e, no limite, 'listing' (o crawler já reclassifica em runtime as páginas que "parecem
// coleção"), NUNCA trava o `add`.
//
// index  = a página lista as EDIÇÕES/issues da newsletter (links internos p/ cada issue; cada
//          issue é um roundup curado depois). listing = a página lista os ARTIGOS direto (links
//          normalmente EXTERNOS, cada um já é o alvo). Só isso muda no crawler (crawl.js:110).
import { z } from 'zod';
import { fetchSmart } from './fetch.js';
import { linksInHtml, readableLinksAsync } from './clean.js';
import { callJSON } from './llm.js';
import { stageModel, HAS_LLM, AGGRESSIVE_DEFAULT } from './config.js';
import { hostOf, log, warn } from './util.js';

// Caminho da PRÓPRIA URL da fonte que sugere um índice de edições.
const INDEX_PATH_RE = /\/(issues?|archive|editions?|newsletters?|numbers?|posts?)(\/|$|\?)/i;
// Um link que parece uma EDIÇÃO/issue: /issues/123, /2026/07, um número solto, etc.
const ISSUE_LINK_RE =
  /\/(issues?|editions?|archive|newsletters?|numbers?)\/[^/]+|\/\d{3,}(\/|$|\?)|\/20\d\d\/\d{1,2}(\/|$|\?)/i;

/** Sinais determinísticos da página (puro — testável sem rede). */
export function gatherTypeSignals({ url, links = [], proseLen = 0 }) {
  const host = hostOf(url);
  const withHost = links.filter((l) => hostOf(l.url));
  const internal = withHost.filter((l) => hostOf(l.url) === host);
  const external = withHost.filter((l) => hostOf(l.url) !== host);
  const issueLike = internal.filter((l) => ISSUE_LINK_RE.test(l.url));
  return {
    host,
    urlMatchesIndexPath: INDEX_PATH_RE.test(url),
    totalLinks: links.length,
    internalLinks: internal.length,
    externalLinks: external.length,
    issueLikeInternalLinks: issueLike.length,
    proseChars: proseLen,
  };
}

/**
 * Palpite determinístico a partir dos sinais. Usado como FALLBACK (sem IA / IA falhou) e também
 * como evidência no prompt. index = a página é predominantemente uma lista de links INTERNOS que
 * parecem edições, com pouca prosa; caso contrário listing (default seguro).
 */
export function heuristicType(sig) {
  const looksLikeIndex =
    (sig.urlMatchesIndexPath && sig.issueLikeInternalLinks >= 3) ||
    (sig.issueLikeInternalLinks >= 8 &&
      sig.issueLikeInternalLinks >= sig.externalLinks &&
      sig.proseChars < 1500);
  return looksLikeIndex ? 'index' : 'listing';
}

const detectSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', description: 'index | listing' },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['type', 'confidence', 'reason'],
  additionalProperties: false,
};
const detectZ = z.object({
  type: z.string(),
  confidence: z.coerce.number().default(0.5),
  reason: z.string().default(''),
});

async function classifyWithLLM({ url, title, sig, sampleLinks }) {
  const { model, effort } = stageModel('detectType');
  const out = await callJSON({
    model,
    reasoning: { effort },
    stage: 'detectType',
    schemaName: 'detect_source_type',
    schema: detectSchema,
    system:
      'Você classifica a página INICIAL de uma newsletter/blog em um de dois tipos, para um crawler. ' +
      'Responda apenas com JSON.\n' +
      '- "index": a página lista as EDIÇÕES/issues da newsletter (cada link leva a uma edição/número ' +
      'do MESMO site, que por sua vez contém vários itens). Ex.: uma página /issues com links p/ ' +
      '/issues/430, /issues/429…\n' +
      '- "listing": a página lista os ARTIGOS/posts direto (cada link já é o conteúdo-alvo, ' +
      'normalmente em OUTRO domínio, ou posts do próprio blog). Ex.: um feed/arquivo de blog, um ' +
      'Substack.\n' +
      'Na dúvida, prefira "listing" (é o comportamento mais simples e o crawler se autocorrige).',
    user:
      `URL da fonte: ${url}\n` +
      `Título da página: ${title || '(sem título)'}\n\n` +
      'SINAIS DETERMINÍSTICOS:\n' +
      `- URL casa padrão de índice (/issues, /archive…): ${sig.urlMatchesIndexPath}\n` +
      `- total de links: ${sig.totalLinks}\n` +
      `- links internos (mesmo domínio): ${sig.internalLinks}\n` +
      `- links externos (outro domínio): ${sig.externalLinks}\n` +
      `- links internos que "parecem edição" (/issues/N, /AAAA/MM, número): ${sig.issueLikeInternalLinks}\n` +
      `- caracteres de prosa (corpo Readability): ${sig.proseChars}\n\n` +
      `AMOSTRA DE LINKS (até 40):\n${sampleLinks.join('\n') || '(nenhum)'}\n\n` +
      'Devolva {type, confidence (0..1), reason (curto, em português)}.',
  });
  const p = detectZ.parse(out);
  return {
    type: p.type === 'index' ? 'index' : 'listing', // clamp fora do LLM (enum não vai no schema)
    confidence: Number.isFinite(p.confidence) ? p.confidence : 0.5,
    reason: p.reason || '',
  };
}

/**
 * Detecta o tipo da fonte a partir da URL. Requer o governador ativo (fetchSmart/callJSON usam as
 * lanes) — o chamador roda dentro de runWithLimits. Retorna { type, confidence, reason, signals,
 * source: 'llm'|'heuristic' }. Nunca lança.
 */
export async function detectSourceType(url, { aggressive = AGGRESSIVE_DEFAULT } = {}) {
  let html = '';
  try {
    const res = await fetchSmart(url, { aggressive, profile: 'listing' });
    html = res?.html || '';
  } catch (e) {
    warn(`detecção de tipo: fetch falhou (${url}): ${e.message}`);
  }

  let links = [];
  let proseLen = 0;
  let title = '';
  if (html) {
    try {
      links = linksInHtml(html, url);
    } catch {
      /* fail-open */
    }
    try {
      const rl = await readableLinksAsync(html, url); // JSDOM no pool (fail-open p/ default)
      proseLen = rl?.textLen || 0;
      title = rl?.title || '';
    } catch {
      /* fail-open */
    }
  }

  const signals = gatherTypeSignals({ url, links, proseLen });
  const guess = heuristicType(signals);

  // Sem chave OU sem página: devolve o palpite heurístico (fail-open, sem custo).
  if (!HAS_LLM || !html) {
    return {
      type: guess,
      confidence: html ? 0.45 : 0.2,
      reason: html ? 'heurística (IA indisponível)' : 'sem página acessível — usando padrão',
      signals,
      source: 'heuristic',
    };
  }

  try {
    const sample = links
      .slice(0, 40)
      .map((l) => `${l.url}${l.title ? ` — ${l.title.slice(0, 80)}` : ''}`);
    const r = await classifyWithLLM({ url, title, sig: signals, sampleLinks: sample });
    log(`detecção de tipo (IA): ${r.type} — ${r.reason}`);
    return { ...r, signals, source: 'llm' };
  } catch (e) {
    warn(`detecção de tipo: IA falhou (${url}): ${e.message} — usando heurística`);
    return {
      type: guess,
      confidence: 0.4,
      reason: `heurística (IA falhou: ${e.message})`,
      signals,
      source: 'heuristic',
    };
  }
}
