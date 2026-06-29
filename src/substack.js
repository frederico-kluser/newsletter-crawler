// Atalho opcional para Substack: usa os endpoints JSON públicos em vez de raspar HTML.
import got from 'got';
import { USER_AGENT } from './config.js';
import { hostOf } from './util.js';

export function isSubstack(url) {
  return hostOf(url).endsWith('.substack.com');
}

/** Lista posts via /api/v1/archive (paginado por offset). */
export async function substackArchive(baseUrl, { limit = 50, max = 300 } = {}) {
  const origin = new URL(baseUrl).origin;
  const out = [];
  for (let offset = 0; offset < max; offset += limit) {
    const api = `${origin}/api/v1/archive?sort=new&limit=${limit}&offset=${offset}`;
    let arr;
    try {
      arr = await got(api, {
        headers: { 'user-agent': USER_AGENT },
        timeout: { request: 20000 },
        retry: { limit: 2 },
      }).json();
    } catch {
      break;
    }
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const p of arr) {
      if (p?.canonical_url) out.push({ url: p.canonical_url, title: p.title, published_at: p.post_date });
    }
    if (arr.length < limit) break;
  }
  return out;
}
