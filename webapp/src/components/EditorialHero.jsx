import { motion } from 'motion/react';
import { useMotionUITheme, useMotionUITransition } from '@/components/motion-ui/ui-theme';
import AnimatedCount from './AnimatedCount.jsx';
import { useStrings } from '../i18n.jsx';
import { fmtDate } from '../lib/format.js';

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Faixa editorial no topo do conteúdo (inspirada em @motion/stats-counters + @motion/stagger-reveal):
 * apresenta o pulso do acervo com números tabulares animados e atalhos rápidos de recorte.
 */
export default function EditorialHero({
  meta,
  totalArticles = 0,
  filteredCount = 0,
  filters,
  dispatch,
  onOpenCommandPalette,
}) {
  const STR = useStrings();
  const uiTheme = useMotionUITheme();
  const uiTransition = useMotionUITransition('ui');
  const snapTransition = useMotionUITransition('snap');
  const still = uiTheme.motionMode === 'off';
  const calm = uiTheme.motionMode === 'calm';

  const totalSources = meta?.sources?.length || 0;
  const activeSources = filters.sourceIds?.length ? filters.sourceIds.length : totalSources;
  const minDate = filters.from || meta?.dates?.min || '';
  const maxDate = filters.to || meta?.dates?.max || '';
  const windowLabel =
    minDate && maxDate
      ? `${fmtDate(minDate)} → ${fmtDate(maxDate)}`
      : maxDate
        ? fmtDate(maxDate)
        : '—';

  const last7Iso = daysAgoIso(7);
  const is7d = filters.from === last7Iso && !filters.to;
  const isAllTime = filters.from === '' && filters.to === '';
  const isTools = filters.kind === 'tool';
  const isReleases = filters.kind === 'release';

  const toggle7d = () => {
    if (is7d) {
      dispatch({ type: 'setPeriod', from: '2026-01-01', to: '' });
    } else {
      dispatch({ type: 'setPeriod', from: last7Iso, to: '' });
    }
  };

  const toggleAllTime = () => {
    if (isAllTime) {
      dispatch({ type: 'setPeriod', from: '2026-01-01', to: '' });
    } else {
      dispatch({ type: 'setPeriod', from: '', to: '' });
    }
  };

  const toggleKind = (k) => {
    dispatch({ type: 'set', key: 'kind', value: filters.kind === k ? 'all' : k });
  };

  return (
    <motion.section
      className="editorial-hero"
      aria-label={STR.heroEyebrow}
      initial={still ? false : { opacity: 0, y: calm ? 0 : 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...uiTransition }}
    >
      <div className="editorial-hero-top">
        <div className="editorial-hero-brand">
          <span className="editorial-eyebrow">
            <span className="editorial-pulse-dot" aria-hidden="true" />
            {STR.heroEyebrow}
          </span>
          {meta?.dates?.max && (
            <span className="editorial-updated">{STR.updatedAt(fmtDate(meta.dates.max))}</span>
          )}
        </div>

        <div className="editorial-quick-row">
          <motion.button
            type="button"
            className="chip editorial-quick-chip"
            data-on={is7d || undefined}
            onClick={toggle7d}
            whileTap={still ? undefined : { scale: 0.96 }}
            transition={{ ...snapTransition }}
          >
            {STR.heroQuick7d}
          </motion.button>
          <motion.button
            type="button"
            className="chip editorial-quick-chip"
            data-on={isTools || undefined}
            onClick={() => toggleKind('tool')}
            whileTap={still ? undefined : { scale: 0.96 }}
            transition={{ ...snapTransition }}
          >
            {STR.heroQuickTools}
          </motion.button>
          <motion.button
            type="button"
            className="chip editorial-quick-chip"
            data-on={isReleases || undefined}
            onClick={() => toggleKind('release')}
            whileTap={still ? undefined : { scale: 0.96 }}
            transition={{ ...snapTransition }}
          >
            {STR.heroQuickReleases}
          </motion.button>
          <motion.button
            type="button"
            className="chip editorial-quick-chip"
            data-on={isAllTime || undefined}
            onClick={toggleAllTime}
            whileTap={still ? undefined : { scale: 0.96 }}
            transition={{ ...snapTransition }}
          >
            {STR.heroQuickAllTime}
          </motion.button>
          {onOpenCommandPalette && (
            <motion.button
              type="button"
              className="chip editorial-cmdk-chip"
              onClick={onOpenCommandPalette}
              whileTap={still ? undefined : { scale: 0.96 }}
              transition={{ ...snapTransition }}
            >
              <span>{STR.cmdkTrigger}</span>
              <kbd className="cmdk-kbd">⌘K</kbd>
            </motion.button>
          )}
        </div>
      </div>

      <div className="editorial-stats-grid">
        <div className="editorial-stat-tile">
          <span className="editorial-stat-rule" data-accent="true" aria-hidden="true" />
          <div className="editorial-stat-value">
            <AnimatedCount value={filteredCount} />
          </div>
          <span className="editorial-stat-label">{STR.heroStatFiltered}</span>
        </div>

        <div className="editorial-stat-tile">
          <span className="editorial-stat-rule" aria-hidden="true" />
          <div className="editorial-stat-value">
            <AnimatedCount value={totalArticles} />
          </div>
          <span className="editorial-stat-label">{STR.heroStatTotal}</span>
        </div>

        <div className="editorial-stat-tile">
          <span className="editorial-stat-rule" aria-hidden="true" />
          <div className="editorial-stat-value">
            <AnimatedCount value={activeSources} />
            <span className="editorial-stat-denom">/{totalSources}</span>
          </div>
          <span className="editorial-stat-label">{STR.heroStatSources}</span>
        </div>

        <div className="editorial-stat-tile">
          <span className="editorial-stat-rule" aria-hidden="true" />
          <div className="editorial-stat-value editorial-stat-date">{windowLabel}</div>
          <span className="editorial-stat-label">{STR.heroStatWindow}</span>
        </div>
      </div>
    </motion.section>
  );
}
