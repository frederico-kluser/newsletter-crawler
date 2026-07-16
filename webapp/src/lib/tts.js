// Síntese de fala (TTS) DIRETO do browser (BYOK) — espelha o transporte de openrouter.js: a chave
// do usuário (localStorage) nunca passa por servidor nosso; CORS liberado pela OpenRouter (mesmo
// /api/v1 da busca). A resposta são BYTES de áudio (audio/mpeg) → Blob p/ um <audio>.
// NÃO enviar HTTP-Referer manual: é forbidden header no fetch (o browser já manda).
import { noteRateLimit } from './lane.js';
import { KeyInvalidError } from './openrouter.js';

const OR_AUDIO_URL = 'https://openrouter.ai/api/v1/audio/speech';
const TTS_TIMEOUT_MS = 60_000;

// Fallback quando o meta.json ainda não traz o bloco `audio` (snapshot antigo). Espelha config.js.
export const AUDIO_DEFAULTS = { model: 'hexgrad/kokoro-82m', voice: 'pf_dora', format: 'mp3' };

/**
 * Gera o áudio de `text` e devolve um Blob (audio/mpeg). Lança KeyInvalidError em 401/403 (a UI
 * reabre o modal de chave) e Error com `.status` nos demais. `signal` cancela em voo.
 */
export async function synthesize({ apiKey, text, model, voice, format = 'mp3', signal }) {
  const input = String(text || '').trim();
  if (!input) throw new Error('texto vazio para TTS');
  if (!apiKey) throw new KeyInvalidError(0);
  const timeout = AbortSignal.timeout(TTS_TIMEOUT_MS);
  const res = await fetch(OR_AUDIO_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'newsletter-acervo-web', // atribuição opcional da OpenRouter
    },
    body: JSON.stringify({ model, input, voice, response_format: format }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (res.status === 401 || res.status === 403) throw new KeyInvalidError(res.status);
  if (res.status === 429) {
    noteRateLimit(); // encolhe a lane compartilhada (mesmo freio da busca)
    const e = new Error('rate limited');
    e.status = 429;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`OpenRouter TTS HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const blob = await res.blob();
  if (!blob || !blob.size) throw new Error('áudio vazio');
  return blob;
}
