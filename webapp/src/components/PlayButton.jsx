import { motion } from 'motion/react';
import { springs } from '../motion/transitions.js';

// Glifos: triângulo (play), quadrado (stop), arco girando (carregando/gerando áudio).
const PlayGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5.14v13.72a1 1 0 0 0 1.54.84l10.29-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14Z" />
  </svg>
);
const StopGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2.5" />
  </svg>
);
const SpinnerGlyph = () => (
  <svg className="play-spinner" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
);

/**
 * Botão de play/stop reutilizado (barra de busca = tocar filtradas; card = tocar 1 resumo).
 * `active` = está tocando/na fila (mostra stop); `loading` = gerando o áudio (spinner).
 */
export default function PlayButton({ active, loading, onClick, playLabel, stopLabel, disabled = false, className = '' }) {
  const label = active ? stopLabel : playLabel;
  return (
    <motion.button
      type="button"
      className={`icon-btn play-btn${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      disabled={disabled}
      whileHover={disabled ? undefined : { scale: 1.06 }}
      whileTap={disabled ? undefined : { scale: 0.92 }}
      transition={springs.snappy}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      {loading ? <SpinnerGlyph /> : active ? <StopGlyph /> : <PlayGlyph />}
    </motion.button>
  );
}
