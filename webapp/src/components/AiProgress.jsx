import { motion, useReducedMotion } from 'motion/react';
import { springs } from '../motion/transitions.js';
import { STR } from '../strings.js';

/**
 * Progresso da busca IA: barra DETERMINÍSTICA (scaleX por lotes/artigos concluídos — transform,
 * nunca width) + brilho varrendo em CSS (desligado sob reduced-motion) + Cancelar que aborta.
 */
export default function AiProgress({ progress, deep, onCancel }) {
  const reduced = useReducedMotion();
  const p = progress || { done: 0, total: 1, relevant: 0, mode: deep ? 'deep' : 'soft' };
  const frac = p.total > 0 ? p.done / p.total : 0;
  const label =
    p.mode === 'deep'
      ? STR.aiProgressDeep(p.done, p.total, p.relevant)
      : STR.aiProgressBatch(p.done, p.total, p.relevant);

  return (
    <div className="ai-progress" role="status">
      <div className="ai-progress-track">
        <motion.div
          className="ai-progress-fill"
          initial={false}
          animate={{ scaleX: Math.max(frac, 0.02) }}
          transition={springs.gentle}
        />
        {!reduced && <div className="ai-progress-shine" aria-hidden="true" />}
      </div>
      <span className="ai-progress-label">
        {label}
        {deep && <em> · {STR.aiDeepWarning}</em>}
      </span>
      <button type="button" className="btn" onClick={onCancel}>
        {STR.cancel}
      </button>
    </div>
  );
}
