import { motion } from 'motion/react';
import { springs } from '../motion/transitions.js';
import { fmtUsd } from '../strings.js';
import { useStrings } from '../i18n.jsx';

/** Cabeçalho dos resultados da busca IA: consulta, contadores, custo real e "limpar". */
export default function AiBanner({ result, onClear }) {
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
          {STR.aiResults(result.relevant, result.scanned)}
          {result.truncated ? ` · ${STR.aiTruncated(result.hits?.length ?? 500)}` : ''}
          {' · '}
          {result.spentUsd > 0 ? STR.aiCost(fmtUsd(result.spentUsd)) : STR.aiCostUnknown}
        </span>
      </div>
      <button type="button" className="btn" onClick={onClear}>
        {STR.aiClear}
      </button>
    </motion.div>
  );
}
