import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { springs } from '../motion/transitions.js';
import AnimatedCount from './AnimatedCount.jsx';
import { fmtEta } from '../strings.js';
import { useStrings } from '../i18n.jsx';

/**
 * Loader da busca IA: barra DETERMINÍSTICA (scaleX por ARTIGOS concluídos — transform, nunca
 * width) + brilho varrendo em CSS (off sob reduced-motion) + linha de métricas ao vivo
 * (X/Y artigos, % , relevantes, custo real, ETA, "não analisados") + Cancelar que aborta.
 * O progresso é nível-artigo nos DOIS modos (soft e profunda), então "quanto já foi processado"
 * é sempre honesto. ETA = elapsed/done · (total-done), recalculada a cada tick + 1 timer de 1s.
 */
export default function AiProgress({ progress, deep, startedAt, onCancel }) {
  const STR = useStrings();
  const reduced = useReducedMotion();
  const p = progress || { done: 0, total: 0, relevant: 0, failed: 0, spentUsd: 0, mode: deep ? 'deep' : 'soft' };
  const total = p.total > 0 ? p.total : 0;
  const frac = total > 0 ? Math.min(1, p.done / total) : 0;
  const pct = Math.round(frac * 100);

  // relógio de 1s só p/ a contagem regressiva do ETA fluir entre os ticks de progresso.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = startedAt ? Math.max(0, now - startedAt) : 0;
  const etaSecs =
    p.done > 0 && total > 0 && p.done < total && elapsed > 0
      ? (elapsed / p.done) * (total - p.done) / 1000
      : null;

  return (
    <div className="ai-progress" role="status" aria-live="polite">
      <div className="ai-progress-bar-row">
        <div className="ai-progress-track">
          <motion.div
            className="ai-progress-fill"
            initial={false}
            animate={{ scaleX: Math.max(frac, 0.02) }}
            transition={springs.gentle}
          />
          {!reduced && <div className="ai-progress-shine" aria-hidden="true" />}
        </div>
        <span className="ai-progress-pct">
          <AnimatedCount value={pct} />%
        </span>
        <button type="button" className="btn ai-progress-cancel" onClick={onCancel}>
          {STR.cancel}
        </button>
      </div>

      <div className="ai-progress-meta">
        <span className="ai-progress-stat ai-progress-strong">
          <AnimatedCount value={p.done} />/{total} {STR.aiUnitArticles}
        </span>
        <span className="ai-progress-dot" aria-hidden="true">·</span>
        <span className="ai-progress-stat">
          <AnimatedCount value={p.relevant} /> {p.relevant === 1 ? STR.aiUnitRelevant : STR.aiUnitRelevants}
        </span>
        {etaSecs != null && (
          <>
            <span className="ai-progress-dot" aria-hidden="true">·</span>
            <span className="ai-progress-stat">{STR.aiEta(fmtEta(etaSecs))}</span>
          </>
        )}
        {p.failed > 0 && (
          <>
            <span className="ai-progress-dot" aria-hidden="true">·</span>
            <span className="ai-progress-stat ai-progress-warn">{STR.aiFailed(p.failed)}</span>
          </>
        )}
        {deep && <span className="ai-progress-hint">· {STR.aiDeepWarning}</span>}
      </div>
    </div>
  );
}
