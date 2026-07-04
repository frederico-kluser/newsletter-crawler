import { AnimatePresence } from 'motion/react';
import { useEffect, useRef } from 'react';
import ArticleCard from './ArticleCard.jsx';
import { useStrings } from '../i18n.jsx';

/**
 * Grid com render incremental + as duas coreografias:
 * - 1ª carga: entrada em STAGGER (delay por índice, cap em 12 — além do fold entra junto);
 * - troca de filtros: AnimatePresence popLayout + layout nos cards → sobreviventes deslizam
 *   (FLIP/transform), removidos saem em fade/scale, novos entram sem delay.
 */
export default function ArticleGrid({ items, toolTypes, onOpen, visible, relationById = null }) {
  const STR = useStrings();
  const { count, hasMore, sentinelRef, loadMore } = visible;
  const firstLoad = useRef(true);
  useEffect(() => {
    firstLoad.current = false;
  }, []);

  const shown = items.slice(0, count);
  return (
    <>
      <div className="grid">
        <AnimatePresence mode="popLayout">
          {shown.map((a, i) => (
            <ArticleCard
              key={a.id}
              article={a}
              toolTypes={toolTypes}
              onOpen={onOpen}
              relation={relationById ? relationById.get(a.id) || null : null}
              entryDelay={firstLoad.current && i < 24 ? Math.min(i, 12) * 0.045 : 0}
            />
          ))}
        </AnimatePresence>
      </div>
      {hasMore && (
        <div className="grid-more">
          <div ref={sentinelRef} className="grid-sentinel" aria-hidden="true" />
          <button type="button" className="btn" onClick={loadMore}>
            {STR.loadMore}
          </button>
        </div>
      )}
    </>
  );
}
