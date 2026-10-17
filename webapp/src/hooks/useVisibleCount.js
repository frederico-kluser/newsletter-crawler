import { useEffect, useRef, useState } from 'react';

/**
 * Render INCREMENTAL da lista (24 por página): pré-requisito das animações — montar 600 cards
 * de uma vez mata o stagger e o layout FLIP. Sentinela com IntersectionObserver (rootMargin
 * 300px) + loadMore explícito p/ acessibilidade.
 *
 * `initialCount`: ao restaurar uma sessão com scroll profundo, já monta o número de páginas que
 * estavam abertas antes do reload para que a altura do documento acomode o `window.scrollTo`.
 * `resetKey`: mudou filtro/busca DEPOIS da montagem inicial, volta à 1ª página (`page`).
 */
export function useVisibleCount(total, resetKey, page = 24, initialCount = page) {
  const [count, setCount] = useState(() => Math.max(page, Number(initialCount) || page));
  const sentinelRef = useRef(null);
  const prevResetKey = useRef(resetKey);

  useEffect(() => {
    if (prevResetKey.current !== resetKey) {
      prevResetKey.current = resetKey;
      setCount(page);
    }
  }, [resetKey, page]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || count >= total) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setCount((c) => Math.min(c + page, total));
      },
      { rootMargin: '300px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [count, total, page]);

  return {
    count: total > 0 ? Math.min(count, total) : count,
    rawCount: count,
    hasMore: count < total,
    sentinelRef,
    setCount,
    loadMore: () => setCount((c) => Math.min(c + page, Math.max(total, page))),
  };
}
