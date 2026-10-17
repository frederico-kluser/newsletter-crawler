import { useEffect, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { ProgressBar } from '@/components/motion-ui/progress-bar';
import AnimatedCount from './AnimatedCount.jsx';
import { fmtEta } from '../strings.js';
import { useStrings } from '../i18n.jsx';

/**
 * Loader da busca IA sobre o primitivo ProgressBar do Motion+ UI:
 * barra determinística (scaleX por artigos concluídos) + brilho varrendo + telemetria ao vivo.
 */
export default function AiProgress({ progress, deep, startedAt, onCancel, resuming = false, baseDone = 0 }) {
  const STR = useStrings();
  const reduced = useReducedMotion();
  const p = progress || { done: 0, total: 0, relevant: 0, failed: 0, spentUsd: 0, mode: deep ? 'deep' : 'soft' };
  const total = p.total > 0 ? p.total : 0;
  const frac = total > 0 ? Math.min(1, p.done / total) : 0;
  const pct = Math.round(frac * 100);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = startedAt ? Math.max(0, now - startedAt) : 0;
  const sessionDone = Math.max(0, p.done - baseDone);
  const sessionTotal = Math.max(0, total - baseDone);
  const etaSecs =
    sessionDone > 0 && sessionTotal > 0 && sessionDone < sessionTotal && elapsed > 0
      ? ((elapsed / sessionDone) * (sessionTotal - sessionDone)) / 1000
      : null;

  return (
    <div className="ai-progress" role="status" aria-live="polite">
      <div className="ai-progress-bar-row">
        <div className="ai-progress-track-wrap">
          <ProgressBar
            value={Math.max(frac, 0.02)}
            reveal={true}
            highlight={true}
            shine={!reduced}
            progressbar={true}
            aria-label={STR.searching}
          />
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
        {resuming && <span className="ai-progress-hint">· {STR.aiResuming}</span>}
        {deep && <span className="ai-progress-hint">· {STR.aiDeepWarning}</span>}
      </div>
    </div>
  );
}
