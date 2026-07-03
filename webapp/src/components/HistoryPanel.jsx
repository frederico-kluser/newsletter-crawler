import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { fades, springs } from '../motion/transitions.js';
import { STR, fmtUsd, fmtDateTime } from '../strings.js';

/**
 * Painel do histórico de buscas (webapp estático → dados no localStorage). Lista completa com
 * abrir (resultado congelado, sem custo), re-rodar e apagar; "limpar tudo" pede 2º clique.
 * Overlay central com fade/scale (mesmo idioma de ConfirmDialog).
 */
export default function HistoryPanel({ open, items, onClose, onOpen, onRerun, onDelete, onClear }) {
  const [armClear, setArmClear] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    setArmClear(false);
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
          className="overlay overlay-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fades.base}
          onClick={onClose}
        >
          <motion.div
            className="dialog history-panel"
            role="dialog"
            aria-modal="true"
            aria-label={STR.historyTitle}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.94, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 6 }}
            transition={springs.snappy}
          >
            <div className="history-head">
              <h2 className="dialog-title">{STR.historyTitle}</h2>
              <button type="button" className="icon-btn" onClick={onClose} aria-label={STR.close}>
                ×
              </button>
            </div>

            {items.length === 0 ? (
              <p className="dialog-body history-empty">{STR.historyEmpty}</p>
            ) : (
              <>
                <ul className="history-list">
                  {items.map((h) => (
                    <li key={h.id} className="history-row">
                      <button
                        type="button"
                        className="history-main"
                        onClick={() => onOpen(h.id)}
                        title={STR.historyReopen}
                      >
                        <span className="history-query">{h.query}</span>
                        <span className="history-meta">
                          {fmtDateTime(h.createdAt)}
                          {` · ${h.deep ? STR.deepToggle : 'soft'}`}
                          {` · ${STR.historyStats(h.stats?.relevant ?? 0, h.stats?.total ?? 0)}`}
                          {h.stats?.spentUsd > 0 ? ` · ${fmtUsd(h.stats.spentUsd)}` : ''}
                        </span>
                      </button>
                      <span className="history-actions">
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => onRerun(h.id)}
                          title={STR.historyRerun}
                          aria-label={STR.historyRerun}
                        >
                          ↻
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => onDelete(h.id)}
                          title={STR.historyDelete}
                          aria-label={STR.historyDelete}
                        >
                          ×
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="history-foot">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      if (armClear) {
                        setArmClear(false);
                        onClear();
                      } else setArmClear(true);
                    }}
                  >
                    {armClear ? STR.historyClearConfirm : STR.historyClear}
                  </button>
                </div>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
