import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadArticles, loadMeta } from '../lib/data.js';
import { buildHaystack } from '../lib/textSearch.js';

/** Carrega meta + artigos do snapshot (contents fica lazy). Expõe retry p/ o ErrorState. */
export function useSnapshot() {
  const [state, setState] = useState({ meta: null, articles: null, error: null });

  const load = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
    Promise.all([loadMeta(), loadArticles()])
      .then(([meta, articles]) => {
        // o snapshot não repete source_name por artigo (economia de bytes) — decoramos aqui;
        // e pré-computamos `_search` (palheiro dobrado) 1x p/ a busca textual não refazer NFD a cada tecla
        const names = new Map(meta.sources.map((s) => [s.id, s.name]));
        const decorated = articles.map((a) => {
          const withName = { ...a, source_name: names.get(a.source_id) || null };
          withName._search = buildHaystack(withName);
          return withName;
        });
        setState({ meta, articles: decorated, error: null });
      })
      .catch((error) => setState({ meta: null, articles: null, error }));
  }, []);

  useEffect(load, [load]);

  // Map id→artigo p/ decorar hits da busca IA e abrir o preview sem varrer o array.
  const byId = useMemo(() => {
    const m = new Map();
    for (const a of state.articles || []) m.set(a.id, a);
    return m;
  }, [state.articles]);

  return {
    meta: state.meta,
    articles: state.articles,
    byId,
    error: state.error,
    loading: !state.meta && !state.error,
    retry: load,
  };
}
