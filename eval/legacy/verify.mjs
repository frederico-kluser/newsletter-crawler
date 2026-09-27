// CONGELADO de src/llm.js (etapa verifyRecord): verifyRecordLLM.
// Texto, json_schema e parse copiados VERBATIM (ver _shared.mjs → FROZEN_FROM). NÃO edite.
import { clampText, legacyRequest, parseWith, t } from './_shared.mjs';

export const VERIFY_VERDICTS = new Set(['ok', 'suspect', 'junk']);

export const verifySchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', description: 'ok | suspect | junk' },
    problems: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'problems'],
  additionalProperties: false,
};

// verifyZ sem zod: verdict desconhecido -> 'suspect' (clamp), problems com default [].
const clampVerdict = (s) =>
  VERIFY_VERDICTS.has(String(s).toLowerCase().trim()) ? String(s).toLowerCase().trim() : 'suspect';
const VERIFY_SHAPE = {
  verdict: t.map(t.string(), clampVerdict),
  problems: t.withDefault(t.array(t.string()), () => []),
};
export const parseVerify = (raw, opts) => parseWith(VERIFY_SHAPE, raw, opts);

/** verifyRecordLLM({url, kind, title, blurb, content}) congelado. */
export function buildVerifyRecordRequest({ url, kind, title, blurb, content }, opts = {}) {
  const clamp = (s) => clampText(s, opts.maxChars);
  return legacyRequest(
    {
      stage: 'verifyRecord',
      schemaName: 'verify_record',
      schema: verifySchema,
      parse: parseVerify,
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
        'EXEMPLO (caso real): se o conteúdo COMEÇA com o menu de navegação do site — ex.: "Website • Docs • ' +
        'Community • Blog • Changelog" — o menu no topo é resto de interface => verdict "suspect", problems ' +
        'ex.: "conteúdo começa com menu de navegação".\n' +
        'problems: lista curta e específica em PT-BR (vazia se ok).\n\n' +
        `REGISTRO\nurl: ${url}\nkind: ${kind || '(sem kind)'}\ntítulo: ${title || '(vazio)'}\n` +
        `blurb do agregador: ${blurb || '(nenhum)'}\n\nconteúdo (recorte):\n${clamp(content)}`,
    },
    opts,
  );
}
