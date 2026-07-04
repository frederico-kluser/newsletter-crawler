import { AnimatePresence, motion } from 'motion/react';
import { springs } from '../motion/transitions.js';
import { useStrings } from '../i18n.jsx';
import { fmtDate } from '../lib/format.js';

/** Deriva as pills removíveis do estado de filtros (kind fica no Segmented). */
function pillsOf(filters, meta, STR) {
  const pills = [];
  if (filters.sourceId != null) {
    const s = meta.sources.find((x) => x.id === filters.sourceId);
    pills.push({ key: 'source', label: s ? s.name : STR.sourceFallback(filters.sourceId), clear: { type: 'set', key: 'sourceId', value: null } });
  }
  if (filters.from || filters.to) {
    const label =
      filters.from && filters.to
        ? `${fmtDate(filters.from)} – ${fmtDate(filters.to)}`
        : filters.from
          ? STR.pillSince(fmtDate(filters.from))
          : STR.pillUntil(fmtDate(filters.to));
    pills.push({ key: 'period', label, clear: { type: 'setPeriod', from: '', to: '' } });
  }
  if (filters.verify) {
    pills.push({ key: 'verify', label: STR.VERIFY_LABEL[filters.verify] || filters.verify, clear: { type: 'set', key: 'verify', value: '' } });
  }
  for (const [facet, tags] of Object.entries(filters.facets || {})) {
    for (const tag of tags) {
      pills.push({
        key: `f:${facet}:${tag}`,
        label: tag,
        title: STR.FACET_LABEL[facet] || facet,
        clear: { type: 'toggleTag', facet, tag },
      });
    }
  }
  return pills;
}

/** Pills dos filtros ativos + "Limpar filtros"; entram/saem com popLayout (troca rápida). */
export default function ActivePills({ filters, meta, dispatch }) {
  const STR = useStrings();
  const pills = pillsOf(filters, meta, STR);
  if (!pills.length) return null;
  return (
    <div className="pills" aria-label={STR.activeFilters}>
      <AnimatePresence mode="popLayout" initial={false}>
        {pills.map((p) => (
          <motion.button
            key={p.key}
            type="button"
            className="pill"
            title={p.title}
            layout
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={springs.snappy}
            onClick={() => dispatch(p.clear)}
          >
            {p.label}
            <span className="pill-x" aria-hidden="true">
              ×
            </span>
          </motion.button>
        ))}
        <motion.button
          key="clear-all"
          type="button"
          className="pill pill-clear"
          layout
          transition={springs.snappy}
          onClick={() => dispatch({ type: 'clear' })}
        >
          {STR.clearFilters}
        </motion.button>
      </AnimatePresence>
    </div>
  );
}
