import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { useMotionUITransition } from '@/components/motion-ui/ui-theme';
import { useStrings } from '../i18n.jsx';

const CAP = 14; // chips visíveis por faceta antes do "+N mais"

/**
 * Grupo de chips de uma faceta. `counts` (tag→n) é a co-ocorrência com a seleção atual: o número
 * exibido vira ao vivo, as tags ZERADAS (não-selecionadas) ficam desabilitadas e a lista é
 * reordenada por contagem.
 */
export default function FacetGroup({
  name,
  label,
  tags,
  selected = [],
  counts,
  tagFilter = '',
  hideLegend = false,
  onToggle,
}) {
  const STR = useStrings();
  const snap = useMotionUITransition('snap');
  const [expanded, setExpanded] = useState(false);
  const countOf = (t) => (counts ? counts[t.tag] ?? 0 : t.count);

  const ordered = useMemo(() => {
    const idx = new Map(tags.map((t, i) => [t.tag, i]));
    const val = (t) => (counts ? counts[t.tag] ?? 0 : t.count);
    const list = tagFilter
      ? tags.filter((t) => t.tag.toLowerCase().includes(tagFilter) || selected.includes(t.tag))
      : tags;
    return [...list].sort((a, b) => val(b) - val(a) || idx.get(a.tag) - idx.get(b.tag));
  }, [tags, counts, tagFilter, selected]);

  const showAll = expanded || Boolean(tagFilter);
  const shown = showAll ? ordered : ordered.filter((t, i) => i < CAP || selected.includes(t.tag));
  const hidden = ordered.length - shown.length;

  return (
    <fieldset className="facet-group">
      <legend className={hideLegend ? 'sr-only' : 'facet-label'}>{label || name}</legend>
      <div className="chip-row">
        {shown.map((t) => {
          const tag = t.tag;
          const on = selected.includes(tag);
          const c = countOf(t);
          const disabled = !on && c === 0;
          return (
            <motion.button
              key={tag}
              type="button"
              className="chip"
              data-on={on || undefined}
              aria-pressed={on}
              disabled={disabled}
              title={disabled ? STR.facetTagUnavailable : undefined}
              onClick={() => !disabled && onToggle(name, tag)}
              whileTap={disabled ? undefined : { scale: 0.94 }}
              transition={snap}
            >
              <span>{tag}</span>
              <span className="chip-count">{c}</span>
            </motion.button>
          );
        })}
        {hidden > 0 && (
          <button type="button" className="chip chip-more" onClick={() => setExpanded(true)}>
            {STR.showMore(hidden)}
          </button>
        )}
        {expanded && !tagFilter && ordered.length > CAP && (
          <button type="button" className="chip chip-more" onClick={() => setExpanded(false)}>
            {STR.showLess}
          </button>
        )}
      </div>
    </fieldset>
  );
}
