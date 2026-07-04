import { motion } from 'motion/react';
import { springs } from '../motion/transitions.js';
import { fmtDateTime } from '../strings.js';
import { useStrings } from '../i18n.jsx';

/**
 * Cabeçalho dos resultados da busca IA: consulta, contadores, custo real e "limpar". Quando o
 * resultado veio do HISTÓRICO (frozen), anota quando foi salvo, itens que saíram do acervo e
 * oferece "rodar de novo" (re-paga).
 */
export default function AiBanner({ result, missing = 0, onClear, onRerun }) {
  const STR = useStrings();
  return (
    <motion.div
      className="ai-banner"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={springs.gentle}
    >
      <div className="ai-banner-text">
        <strong>“{result.query}”</strong>
        <span>
          {result.frozen ? `${STR.historyFrozen(fmtDateTime(result.createdAt))} · ` : ''}
          {STR.aiResults(result.relevant, result.scanned)}
          {result.truncated ? ` · ${STR.aiTruncated(result.hits?.length ?? 500)}` : ''}
          {missing > 0 ? ` · ${STR.historyMissing(missing)}` : ''}
        </span>
      </div>
      <span className="ai-banner-actions">
        {result.frozen && onRerun && (
          <button type="button" className="btn" onClick={onRerun}>
            ↻ {STR.historyRerun}
          </button>
        )}
        <button type="button" className="btn" onClick={onClear}>
          {STR.aiClear}
        </button>
      </span>
    </motion.div>
  );
}
