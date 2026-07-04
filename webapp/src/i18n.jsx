import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { DICTS, setFmtLocale } from './strings.js';
import { getLocale, setLocale as persistLocale } from './lib/storage.js';
import { DEFAULT_LOCALE, resolveLocale, SUPPORTED } from './lib/locale.js';

// Re-exporta a regra de idioma (pura, coberta por test/i18n.test.js) pra quem importa do i18n.
export { DEFAULT_LOCALE, resolveLocale, SUPPORTED };

/** Escolha salva vence; senão detecta pelo browser. Mesmo mecanismo do pré-paint no index.html. */
function detectLocale() {
  const saved = getLocale();
  if (saved === 'pt' || saved === 'en') return saved;
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const langs = nav ? nav.languages || (nav.language ? [nav.language] : []) : [];
  return resolveLocale(langs);
}

const LocaleContext = createContext(null);

/**
 * Provê o locale efetivo + strings pra toda a árvore. Trocar idioma só re-renderiza os
 * consumidores (nada de remount) — o estado da busca/filtros é preservado. `setFmtLocale`
 * roda no corpo (var de módulo, não-DOM) pra fmtUsd já sair no idioma certo no 1º paint.
 */
export function LocaleProvider({ children }) {
  const [locale, setLocaleState] = useState(detectLocale);
  setFmtLocale(locale);

  useEffect(() => {
    document.documentElement.lang = locale === 'pt' ? 'pt-BR' : 'en';
  }, [locale]);

  const setLocale = useCallback((l) => {
    const next = l === 'pt' ? 'pt' : 'en';
    persistLocale(next);
    setLocaleState(next);
  }, []);

  const toggle = useCallback(() => {
    setLocaleState((cur) => {
      const next = cur === 'pt' ? 'en' : 'pt';
      persistLocale(next);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ locale, setLocale, toggle, strings: DICTS[locale] }),
    [locale, setLocale, toggle],
  );
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** Locale + controles (pro toggle). Lança se usado fora do provider (bug de montagem). */
export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale precisa estar dentro de <LocaleProvider>');
  return ctx;
}

/** Atalho: só o dicionário do idioma ativo (substitui o antigo `import { STR }`). */
export function useStrings() {
  return useLocale().strings;
}
