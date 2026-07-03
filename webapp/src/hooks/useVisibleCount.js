import { useEffect, useRef, useState } from 'react';

/**
 * Render INCREMENTAL da lista (24 por página): pré-requisito das animações — montar 600 cards
 * de uma vez mata o stagger e o layout FLIP. Sentinela com IntersectionObserver (rootMargin
 * 600px, mesmo padrão do web-ui do CLI) + loadMore explícito p/ acessibilidade.
 * `resetKey`: mudou filtro/busca, volta à 1ª página.
 */
export function useVisibleCount(total, resetKey, page = 24) {
  const [count, setCount] = useState(page);
  const sentinelRef = useRef(null);

  useEffect(() => {
    setCount(page);
  }, [resetKey, page]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || count >= total) return undefined;
    // rootMargin 300px = prefetch suave (carrega a próxima leva pouco antes do fim) sem estourar
    // 2 páginas já no scroll 0 num viewport alto (o alvo é DOM inicial enxuto p/ o stagger/FLIP).
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
    count: Math.min(count, total),
    hasMore: count < total,
    sentinelRef,
    loadMore: () => setCount((c) => Math.min(c + page, total)),
  };
}
