import { useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { fades, springs } from '../motion/transitions.js';
import { fmtUsd } from '../strings.js';
import { useStrings } from '../i18n.jsx';

/** Guard de custo da busca IA: mostra escopo, nº de chamadas e ~US$ antes de gastar. */
export default function ConfirmDialog({ info, onConfirm, onCancel }) {
  const STR = useStrings();
  useEffect(() => {
    if (!info) return undefined;
    const onKey = (e) => e.key === 'Escape' && onCancel();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [info, onCancel]);

  return (
    <AnimatePresence>
      {info && (
        <motion.div
          className="overlay overlay-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fades.base}
          onClick={onCancel}
        >
          <motion.div
            className="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-label={STR.confirmTitle}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.92, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 6 }}
            transition={springs.snappy}
          >
            <h2 className="dialog-title">{STR.confirmTitle}</h2>
            <p className="dialog-body">{STR.confirmBody(info.count, info.calls, fmtUsd(info.usd))}</p>
            <p className="dialog-query">“{info.query}”</p>
            {info.deep && <p className="dialog-warn">{STR.aiDeepWarning}</p>}
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={onCancel}>
                {STR.confirmCancel}
              </button>
              <button type="button" className="btn btn-primary" onClick={onConfirm}>
                {STR.confirmGo}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
