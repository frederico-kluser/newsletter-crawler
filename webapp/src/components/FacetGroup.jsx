import { useState } from 'react';
import { motion } from 'motion/react';
import { springs } from '../motion/transitions.js';
import { useStrings } from '../i18n.jsx';

const CAP = 14; // chips visíveis por faceta antes do "+N mais" (paridade com o web-ui do CLI)

/** Grupo de chips de uma faceta, com contagem por tag e expansão além do cap. */
export default function FacetGroup({ name, label, tags, selected = [], onToggle }) {
  const STR = useStrings();
  const [expanded, setExpanded] = useState(false);
  // selecionadas sempre visíveis, mesmo além do cap (senão a pill ativa "some" do painel)
  const shown = expanded ? tags : tags.filter((t, i) => i < CAP || selected.includes(t.tag));
  const hidden = tags.length - shown.length;

  return (
    <fieldset className="facet-group">
      <legend className="facet-label">{label || name}</legend>
      <div className="chip-row">
        {shown.map(({ tag, count }) => {
          const on = selected.includes(tag);
          return (
            <motion.button
              key={tag}
              type="button"
              className="chip"
              data-on={on || undefined}
              aria-pressed={on}
              onClick={() => onToggle(name, tag)}
              whileTap={{ scale: 0.94 }}
              transition={springs.snappy}
            >
              {tag}
              <span className="chip-count">{count}</span>
            </motion.button>
          );
        })}
        {hidden > 0 && (
          <button type="button" className="chip chip-more" onClick={() => setExpanded(true)}>
            {STR.showMore(hidden)}
          </button>
        )}
        {expanded && tags.length > CAP && (
          <button type="button" className="chip chip-more" onClick={() => setExpanded(false)}>
            {STR.showLess}
          </button>
        )}
      </div>
    </fieldset>
  );
}
