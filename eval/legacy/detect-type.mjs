// CONGELADO de src/detect-type.js (etapa detectType): o prompt do classifyWithLLM (index|listing).
// Os sinais determinísticos (gatherTypeSignals) seguem em src/ — aqui entra só o objeto `sig`
// já calculado. Texto, json_schema e parse copiados VERBATIM (ver _shared.mjs → FROZEN_FROM).
import { legacyRequest, parseWith, t } from './_shared.mjs';

export const detectSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', description: 'index | listing' },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['type', 'confidence', 'reason'],
  additionalProperties: false,
};

// detectZ sem zod + o clamp que o original fazia FORA do LLM (enum não ia no schema).
const DETECT_SHAPE = {
  type: t.string(),
  confidence: t.withDefault(t.coerceNumber(), 0.5),
  reason: t.withDefault(t.string(), ''),
};
export function parseDetectType(raw, opts) {
  const p = parseWith(DETECT_SHAPE, raw, opts);
  if (!p) return null;
  return {
    type: p.type === 'index' ? 'index' : 'listing',
    confidence: Number.isFinite(p.confidence) ? p.confidence : 0.5,
    reason: p.reason || '',
  };
}

/** classifyWithLLM({url, title, sig, sampleLinks}) congelado. */
export function buildDetectTypeRequest({ url, title, sig, sampleLinks }, opts = {}) {
  return legacyRequest(
    {
      stage: 'detectType',
      schemaName: 'detect_source_type',
      schema: detectSchema,
      parse: parseDetectType,
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
    },
    opts,
  );
}
