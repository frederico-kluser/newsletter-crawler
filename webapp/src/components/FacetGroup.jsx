import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { springs } from '../motion/transitions.js';
import { useStrings } from '../i18n.jsx';

const CAP = 14; // chips visíveis por faceta antes do "+N mais" (paridade com o web-ui do CLI)

/**
 * Grupo de chips de uma faceta. `counts` (tag→n) é a co-ocorrência com a seleção atual: o número
 * exibido vira ao vivo, as tags ZERADAS (não-selecionadas) ficam desabilitadas e a lista é
 * reordenada por contagem (as acionáveis sobem acima do "+N mais"; a selecionada = |R| ancora no
 * topo). `counts` ausente (acervo carregando) → cai no total estático `t.count`, sem desabilitar.
 */
export default function FacetGroup({ name, label, tags, selected = [], counts, onToggle }) {
  const STR = useStrings();
  const [expanded, setExpanded] = useState(false);
  const countOf = (t) => (counts ? counts[t.tag] ?? 0 : t.count);
  // ordena por contagem viva desc, desempate estável pela ordem original (total desc do export) —
  // em repouso (sem counts / sem filtro) a ordem fica idêntica à do snapshot.
  const ordered = useMemo(() => {
    const idx = new Map(tags.map((t, i) => [t.tag, i]));
    const val = (t) => (counts ? counts[t.tag] ?? 0 : t.count);
    return [...tags].sort((a, b) => val(b) - val(a) || idx.get(a.tag) - idx.get(b.tag));
  }, [tags, counts]);
  // selecionadas sempre visíveis, mesmo além do cap (senão a pill ativa "some" do painel)
  const shown = expanded ? ordered : ordered.filter((t, i) => i < CAP || selected.includes(t.tag));
  const hidden = ordered.length - shown.length;

  return (
    <fieldset className="facet-group">
      <legend className="facet-label">{label || name}</legend>
      <div className="chip-row">
        {shown.map((t) => {
          const tag = t.tag;
          const on = selected.includes(tag);
          const c = countOf(t);
          const disabled = !on && c === 0; // sem itens no contexto atual → sem clique
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
              transition={springs.snappy}
            >
              {tag}
              <span className="chip-count">{c}</span>
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
