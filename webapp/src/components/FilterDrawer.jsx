import { AnimatePresence, motion } from 'motion/react';
import { useEffect } from 'react';
import FilterPanel from './FilterPanel.jsx';
import { fades, springs } from '../motion/transitions.js';
import { STR } from '../strings.js';

/**
 * Drawer inferior de filtros (mobile <900px): entra por baixo com spring, fecha por backdrop,
 * Esc ou ARRASTO para baixo (offset > 120px ou flick > 800px/s — só transform, sem thrash).
 */
export default function FilterDrawer({ open, onClose, meta, filters, dispatch }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fades.base}
          onClick={onClose}
        >
          <motion.div
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-label={STR.filters}
            onClick={(e) => e.stopPropagation()}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={springs.sheet}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.5 }}
            onDragEnd={(e, info) => {
              if (info.offset.y > 120 || info.velocity.y > 800) onClose();
            }}
          >
            <div className="drawer-handle" aria-hidden="true" />
            <div className="drawer-body">
              <FilterPanel meta={meta} filters={filters} dispatch={dispatch} />
            </div>
            <div className="drawer-footer">
              <button type="button" className="btn btn-primary" onClick={onClose}>
                {STR.close}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
