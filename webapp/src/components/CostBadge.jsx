import AnimatedCount from './AnimatedCount.jsx';
import { STR, fmtUsd } from '../strings.js';

/**
 * Custo de IA no topo: acumulado da coleta (meta.cost) + o gasto da SESSÃO de busca (F4).
 * O número conta suavemente quando o gasto da sessão cresce durante uma busca.
 */
export default function CostBadge({ baseUsd = 0, sessionUsd = 0 }) {
  const total = (Number(baseUsd) || 0) + (Number(sessionUsd) || 0);
  return (
    <span className="cost-badge" title={STR.costBadgeTitle}>
      <span className="cost-badge-label">IA</span>
      <AnimatedCount value={total} format={fmtUsd} />
    </span>
  );
}
