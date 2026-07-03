import { motion } from 'motion/react';
import { springs } from '../motion/transitions.js';

/**
 * Controle segmentado (Tudo/Notícias/Ferramentas/Releases) com thumb COMPARTILHADO:
 * um único elemento layoutId desliza entre as opções (FLIP = transform, zero layout thrash).
 */
export default function Segmented({ value, options, onChange, label }) {
  return (
    <div className="seg" role="tablist" aria-label={label}>
      {options.map((opt) => {
        const on = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={on}
            className="seg-item"
            data-on={on || undefined}
            onClick={() => onChange(opt.value)}
          >
            {on && <motion.span layoutId="seg-thumb" className="seg-thumb" transition={springs.snappy} />}
            <span className="seg-label">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
