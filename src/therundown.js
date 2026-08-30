// Atalho opcional para The Rundown: usa o índice JSON público (/api/articles-index) em vez de
// raspar o HTML da listagem. Motivo: o DOM de /articles expõe só os 8 artigos mais recentes — a
// paginação "1..167" é client-side (estado React alimentado por UMA request ao endpoint) e o
// scroll não adiciona nada — então o arquivo completo (~1.329 artigos) só é alcançável via JSON.
import got from 'got';
import { USER_AGENT } from './config.js';
import { hostOf, parseDate, debug } from './util.js';

// O endpoint devolve o índice INTEIRO numa request só (sem paginação): array JSON de itens
// {slug, publishDate, title, category, ...}, do mais novo ao mais antigo (~784 KB).
export const RUNDOWN_INDEX_PATH = '/api/articles-index';
// Teto de segurança contra um payload gigante/malformado (o índice real tem ~1.329 itens).
const RUNDOWN_MAX_ITEMS = Number(process.env.RUNDOWN_MAX_ITEMS || 5000);

// GET cru (status+body) — injetável nos testes via `_get`.
async function getRaw(url) {
  const res = await got(url, {
    headers: { 'user-agent': USER_AGENT },
    timeout: { request: 20000 },
    retry: { limit: 2 },
    throwHttpErrors: false,
  });
  return { status: res.statusCode, headers: res.headers, body: res.body };
}

const _isRundown = new Map(); // host -> bool (cache por processo, como o needsJs de fetch.js)

/**
 * É The Rundown? Probe cacheado por host: GET {origin}/api/articles-index deve devolver 200 com
 * um array JSON de >= 1 item {slug, publishDate}. Fail-safe: qualquer erro/timeout => não-Rundown
 * (segue o fluxo HTML normal). ATENÇÃO: robots.txt DISALLOWA /api/ — quem chama (processListing)
 * só invoca isto em modo agressivo (default do crawler); o endpoint nunca é tocado em modo educado.
 */
export async function isRundown(url, { _get = getRaw } = {}) {
  const host = hostOf(url);
  if (!host) return false;
  if (_isRundown.has(host)) return _isRundown.get(host);
  let ok = false;
  try {
    const origin = new URL(url).origin;
    const r = await _get(`${origin}${RUNDOWN_INDEX_PATH}`);
    if (r.status === 200) {
      const arr = JSON.parse(r.body);
      ok = Array.isArray(arr) &&
        arr.some((it) => typeof it?.slug === 'string' && typeof it?.publishDate === 'string');
    }
  } catch {
    ok = false;
  }
  if (ok) debug(`therundown detectado via /api/articles-index: ${host}`);
  _isRundown.set(host, ok);
  return ok;
}

/**
 * Índice JSON completo do The Rundown (1 request, sem paginação): devolve
 * [{url: origin + '/articles/' + slug, published_at: publishDate}] — SEM filtrar por data
 * (o chamador filtra, mesma divisão de trabalho do atalho Substack). `sinceDate` é aceito por
 * simetria com o contrato do substackArchive, mas não é aplicado aqui: o índice chega INTEIRO
 * numa resposta só, então não há paginação a encurtar — o filtro é do chamador. Itens sem
 * slug/publishDate válidos são descartados (limite de segurança). Array vazio/parse falho => [].
 */
export async function rundownArchive(baseUrl, { sinceDate = null, _get = getRaw } = {}) {
  const origin = new URL(baseUrl).origin;
  let arr;
  try {
    const r = await _get(`${origin}${RUNDOWN_INDEX_PATH}`);
    if (r.status !== 200) return [];
    arr = JSON.parse(r.body);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr.slice(0, RUNDOWN_MAX_ITEMS)) {
    if (typeof it?.slug !== 'string' || !it.slug) continue;
    if (typeof it?.publishDate !== 'string' || !it.publishDate) continue;
    if (parseDate(it.publishDate) == null) continue; // publishDate inválido (não-ISO/lixo)
    out.push({ url: `${origin}/articles/${it.slug}`, published_at: it.publishDate });
  }
  return out;
}