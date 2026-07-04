// Regra de idioma do produto — pura e sem React/DOM (por isso vive em lib/ e é testável em
// node:test). Só português vira 'pt'; QUALQUER outro idioma cai em 'en'. Espelha exatamente o
// pré-paint inline do index.html e o resolveLocale re-exportado por i18n.jsx.
export const SUPPORTED = ['pt', 'en'];
export const DEFAULT_LOCALE = 'en';

/**
 * Resolve um locale suportado a partir da(s) preferência(s) do browser (string ou array, na
 * ordem de preferência). Aceita `navigator.languages` direto; itens não-string são ignorados.
 */
export function resolveLocale(languages) {
  const list = Array.isArray(languages) ? languages : languages ? [languages] : [];
  for (const l of list) {
    if (typeof l !== 'string') continue;
    // subtag primária BCP-47 (antes do 1º "-"): 'pt', 'pt-BR', 'pt-PT' → pt; 'ptx' NÃO é pt.
    if (l.trim().toLowerCase().split('-')[0] === 'pt') return 'pt';
  }
  return DEFAULT_LOCALE;
}
