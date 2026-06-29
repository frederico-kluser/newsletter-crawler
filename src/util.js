// Utilitários puros (sem dependência dos módulos de fetch/db, para evitar ciclos).
import crypto from 'node:crypto';
import normalizeUrlLib from 'normalize-url';

/** Normaliza e absolutiza uma URL; retorna null se inválida. */
export function normalizeUrl(u, base) {
  if (!u) return null;
  try {
    const abs = base ? new URL(u, base).href : new URL(u).href;
    return normalizeUrlLib(abs, {
      stripHash: true,
      removeQueryParameters: [/^utm_/i, 'ref', 'fbclid', 'gclid', 'mc_cid', 'mc_eid'],
      sortQueryParameters: true,
      removeTrailingSlash: true,
    });
  } catch {
    return null;
  }
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s || '').digest('hex');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Espera baseMs com jitter de 0.5x–1.5x para cortesia anti-bot. */
export async function jitterDelay(baseMs) {
  if (!baseMs) return;
  await sleep(Math.floor(baseMs * (0.5 + Math.random())));
}

export function hostOf(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
}

/** Assinatura de template: host + tipo de página (chave do cache de seletores). */
export function domainSig(u, kind = 'listing') {
  return `${hostOf(u)}:${kind}`;
}

export function slugify(s) {
  return (
    (s || 'untitled')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  );
}

const ts = () => new Date().toISOString();
export const log = (...a) => console.log(`[${ts()}]`, ...a);
export const warn = (...a) => console.warn(`[${ts()}] WARN`, ...a);
export const errorLog = (...a) => console.error(`[${ts()}] ERROR`, ...a);
