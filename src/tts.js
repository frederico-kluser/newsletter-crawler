// Síntese de fala (TTS) via OpenRouter Audio API (POST /api/v1/audio/speech). Diferente do resto
// da camada LLM, a resposta são BYTES de áudio (audio/mpeg), não JSON — por isso não passa pelo
// SDK openai/callJSON. HTTP pelo `got` (regra do repo: nunca `axios`). Sem efeito colateral ao
// importar; não faz log próprio (quem chama decide). Lê OPENROUTER_API_KEY no momento da chamada
// (live binding ESM) — não capturar em const local ao importar.
import got from 'got';
import {
  OPENROUTER_API_KEY,
  HTTP_REFERER,
  X_TITLE,
  TTS_MODEL,
  TTS_VOICE,
  TTS_FORMAT,
  TTS_TIMEOUT_MS,
} from './config.js';

const OR_AUDIO_URL = 'https://openrouter.ai/api/v1/audio/speech';

// Content-Type por formato pedido (fallback caso a OpenRouter não devolva o header).
const CONTENT_TYPE = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};

/** Erro de TTS carregando o `status` HTTP (0 = rede) p/ o chamador mapear a resposta. */
export class TtsError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'TtsError';
    this.status = status;
  }
}

// Extrai uma mensagem curta do corpo de erro (Buffer). A OpenRouter costuma devolver JSON
// {error:{message}} mesmo no caminho de áudio; fail-open p/ texto cru.
function safeErrText(body) {
  try {
    const txt = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
    const trimmed = txt.trim();
    if (!trimmed) return '';
    try {
      const j = JSON.parse(trimmed);
      return String(j?.error?.message || j?.message || trimmed).slice(0, 300);
    } catch {
      return trimmed.slice(0, 300);
    }
  } catch {
    return '';
  }
}

/**
 * Sintetiza `text` em áudio via OpenRouter. Retorna { buffer, contentType, model, voice,
 * generationId }. Lança TtsError (com `.status`) em texto vazio (400), sem chave (401), erro HTTP
 * (status da resposta) ou áudio vazio (502). Aceita `signal` (AbortSignal) p/ cancelar em voo.
 */
export async function synthesizeSpeech({
  text,
  model = TTS_MODEL,
  voice = TTS_VOICE,
  format = TTS_FORMAT,
  speed,
  signal,
} = {}) {
  const input = String(text || '').trim();
  if (!input) throw new TtsError('texto vazio para TTS', 400);
  if (!OPENROUTER_API_KEY) throw new TtsError('sem OPENROUTER_API_KEY', 401);

  const body = { model, input, voice, response_format: format };
  if (Number.isFinite(speed) && speed > 0) body.speed = speed;

  let res;
  try {
    res = await got.post(OR_AUDIO_URL, {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': HTTP_REFERER, // no servidor podemos mandar Referer (o browser não pode)
        'X-Title': X_TITLE,
      },
      json: body, // got serializa e seta Content-Type: application/json
      responseType: 'buffer',
      throwHttpErrors: false, // erros HTTP devolvem statusCode em vez de lançar
      timeout: { request: TTS_TIMEOUT_MS },
      retry: { limit: 1 },
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    throw new TtsError(`falha de rede no TTS: ${e.message}`, 0);
  }

  if (res.statusCode !== 200) {
    const detail = safeErrText(res.body);
    throw new TtsError(`OpenRouter TTS HTTP ${res.statusCode}${detail ? `: ${detail}` : ''}`, res.statusCode);
  }

  const buffer = res.body;
  if (!buffer || !buffer.length) throw new TtsError('TTS devolveu áudio vazio', 502);

  const contentType = res.headers['content-type'] || CONTENT_TYPE[format] || 'application/octet-stream';
  return {
    buffer,
    contentType,
    model,
    voice,
    generationId: res.headers['x-generation-id'] || null,
  };
}
