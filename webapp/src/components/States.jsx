import { motion } from 'motion/react';
import { springs } from '../motion/transitions.js';
import { useStrings } from '../i18n.jsx';

/** Vazio (base vazia ou filtros sem resultado) — entrada com spring sutil. */
export function EmptyState({ title, hint = null }) {
  return (
    <motion.div
      className="state"
      initial={{ opacity: 0, scale: 0.92, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={springs.gentle}
    >
      <span className="state-glyph" aria-hidden="true">
        ◌
      </span>
      <p className="state-title">{title}</p>
      {hint && <p className="state-hint">{hint}</p>}
    </motion.div>
  );
}

/** Falha ao carregar o snapshot (ou o conteúdo) com retry. */
export function ErrorState({ message, onRetry }) {
  const STR = useStrings();
  return (
    <motion.div
      className="state"
      initial={{ opacity: 0, scale: 0.92, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={springs.gentle}
      role="alert"
    >
      <span className="state-glyph state-glyph-error" aria-hidden="true">
        !
      </span>
      <p className="state-title">{message}</p>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          {STR.retry}
        </button>
      )}
    </motion.div>
  );
}
