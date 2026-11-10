import { motion } from 'motion/react';
import { springs } from '../motion/transitions.js';

// Estrela (favoritar/desfavoritar): contorno quando fora, preenchida quando favorito.
const StarGlyph = ({ filled }) => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 2.6l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.4l-5.8 3.06 1.1-6.46-4.69-4.58 6.49-.94L12 2.6Z" />
  </svg>
);

/**
 * Botão de favorito reutilizável (card = guarda a matéria; sheet = mesmo estado no preview).
 * `active` = é favorito (estrela preenchida); rótulo/aria trocam entre add/remove.
 */
export default function FavButton({ active, onClick, addLabel, removeLabel, className = '' }) {
  const label = active ? removeLabel : addLabel;
  return (
    <motion.button
      type="button"
      className={`icon-btn fav-btn${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      whileHover={{ scale: 1.08 }}
      whileTap={{ scale: 0.9 }}
      transition={springs.snappy}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      <StarGlyph filled={active} />
    </motion.button>
  );
}
