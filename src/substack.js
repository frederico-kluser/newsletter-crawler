// Atalho opcional para Substack: usa os endpoints JSON públicos em vez de raspar HTML.
// Muitas newsletters rodam no Substack com DOMÍNIO PRÓPRIO (ex.: deeplearningweekly.com) — aí o
// hostname NÃO termina em .substack.com, então a detecção vale-se do header `x-served-by:
// Substack` e do array JSON de /api/v1/archive, não do nome do host.
import got from 'got';
import { USER_AGENT } from './config.js';
import { hostOf, parseDate, debug } from './util.js';

// O arquivo do Substack limita o page size a 12 (limit>12 devolve []). Paginar por offset.
export const SUBSTACK_PAGE = 12;
// Teto de segurança de offset p/ backfill sem --since (a parada por data corta bem antes disso).
const SUBSTACK_MAX_OFFSET = Number(process.env.SUBSTACK_MAX_OFFSET || 600);
// Tipos de post que são "issues" reais; `tts` é a versão em áudio (mesmo canonical_url) — ignorar.
const POST_TYPES = new Set(['newsletter', 'podcast', 'thread']);

function archiveApi(origin, offset, limit = SUBSTACK_PAGE) {
  return `${origin}/api/v1/archive?sort=new&limit=${limit}&offset=${offset}`;
}

// GET cru (status+headers+body) — injetável nos testes via `_get`.
async function getRaw(url) {
  const res = await got(url, {
    headers: { 'user-agent': USER_AGENT },
    timeout: { request: 20000 },
    retry: { limit: 2 },
    throwHttpErrors: false,
  });
  return { status: res.statusCode, headers: res.headers, body: res.body };
}

const _isSub = new Map(); // host -> bool (cache por processo, como o needsJs de fetch.js)

/**
 * É Substack? `*.substack.com` resolve na hora; domínio próprio cai num probe cacheado por host:
 * é Substack se o header `x-served-by` disser Substack OU se /api/v1/archive devolver um array
 * com `canonical_url`. Fail-safe: qualquer erro/timeout => não-Substack (segue o fluxo HTML normal).
 */
export async function isSubstack(url, { _get = getRaw } = {}) {
  const host = hostOf(url);
  if (!host) return false;
  if (host.endsWith('.substack.com')) return true;
  if (_isSub.has(host)) return _isSub.get(host);
  let ok = false;
  try {
    const origin = new URL(url).origin;
    const r = await _get(archiveApi(origin, 0, 1));
    if (/substack/i.test(String(r.headers?.['x-served-by'] || ''))) ok = true;
    else if (r.status === 200) {
      const arr = JSON.parse(r.body);
      ok = Array.isArray(arr) && arr.length > 0 && !!arr[0]?.canonical_url;
    }
  } catch {
    ok = false;
  }
  if (ok) debug(`substack detectado em domínio próprio: ${host}`);
  _isSub.set(host, ok);
  return ok;
}

/**
 * Lista posts via /api/v1/archive, paginado por offset (page size 12, do mais novo ao mais antigo).
 * Para no fim do arquivo (página vazia ou < 12) OU cedo quando a página inteira já está abaixo de
 * `sinceDate` — como o feed é ordenado por data, o resto é ainda mais antigo (backfill incremental
 * barato). Filtra o áudio `tts` e deduplica por URL. Retorna [{url, title, published_at}].
 */
export async function substackArchive(
  baseUrl,
  { sinceDate = null, maxOffset = SUBSTACK_MAX_OFFSET, _get = getRaw } = {},
) {
  const origin = new URL(baseUrl).origin;
  const sinceMs = sinceDate instanceof Date ? sinceDate.getTime() : null;
  const seen = new Set();
  const out = [];
  for (let offset = 0; offset < maxOffset; offset += SUBSTACK_PAGE) {
    let arr;
    try {
      const r = await _get(archiveApi(origin, offset));
      if (r.status !== 200) break;
      arr = JSON.parse(r.body);
    } catch {
      break;
    }
    if (!Array.isArray(arr) || arr.length === 0) break;
    let newestMs = null;
    for (const p of arr) {
      const purl = p?.canonical_url;
      if (!purl || seen.has(purl)) continue;
      if (p.type && !POST_TYPES.has(p.type)) continue; // pula tts/áudio e afins
      seen.add(purl);
      out.push({ url: purl, title: p.title, published_at: p.post_date });
      const ms = parseDate(p.post_date)?.getTime();
      if (ms != null && (newestMs == null || ms > newestMs)) newestMs = ms;
    }
    // Parada por data: se o item MAIS NOVO desta página já está abaixo do piso, todo o resto do
    // arquivo é mais antigo — não adianta paginar mais.
    if (sinceMs != null && newestMs != null && newestMs < sinceMs) break;
    if (arr.length < SUBSTACK_PAGE) break; // última página do arquivo
  }
  return out;
}
