import { motion } from 'motion/react';
import { STR } from '../strings.js';
import { springs } from '../motion/transitions.js';

const KeyIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="15" r="4" />
    <path d="M10.8 12.2 21 2m-4 4 2.5 2.5M14.5 8.5 17 11" />
  </svg>
);

/**
 * Ponto de entrada FIXO da chave (topbar): identifica se há chave salva (ponto verde) e abre
 * o modal p/ inserir/trocar/esquecer — proativamente, sem precisar tentar uma busca antes.
 */
export default function KeyButton({ hasKey, onClick }) {
  return (
    <motion.button
      type="button"
      className="icon-btn key-btn"
      data-has={hasKey || undefined}
      onClick={onClick}
      whileHover={{ scale: 1.06 }}
      whileTap={{ scale: 0.92 }}
      transition={springs.snappy}
      aria-label={hasKey ? STR.keyBtnHas : STR.keyBtnMissing}
      title={hasKey ? STR.keyBtnHas : STR.keyBtnMissing}
    >
      <KeyIcon />
      {hasKey && <span className="key-dot" aria-hidden="true" />}
    </motion.button>
  );
}
