import { motion } from 'motion/react';
import { useStrings } from '../i18n.jsx';
import { springs } from '../motion/transitions.js';
import { getProvider } from '../lib/storage.js';

const KeyIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="15" r="4" />
    <path d="M10.8 12.2 21 2m-4 4 2.5 2.5M14.5 8.5 17 11" />
  </svg>
);

/**
 * Ponto de entrada FIXO da chave (topbar): identifica se há chave salva (ponto verde) e abre
 * o modal p/ inserir/trocar/esquecer — proativamente, sem precisar tentar uma busca antes.
 * Rótulo provider-aware: sem chave o provedor é sempre o default (openrouter); com chave, o
 * texto reflete o provedor salvo.
 */
export default function KeyButton({ hasKey, onClick }) {
  const STR = useStrings();
  const isDs = hasKey && getProvider() === 'deepseek';
  const label = hasKey
    ? (isDs ? STR.keyBtnHasDs : STR.keyBtnHas)
    : (isDs ? STR.keyBtnMissingDs : STR.keyBtnMissing);
  return (
    <motion.button
      type="button"
      className="icon-btn key-btn"
      data-has={hasKey || undefined}
      onClick={onClick}
      whileHover={{ scale: 1.06 }}
      whileTap={{ scale: 0.92 }}
      transition={springs.snappy}
      aria-label={label}
      title={label}
    >
      <KeyIcon />
      {hasKey && <span className="key-dot" aria-hidden="true" />}
    </motion.button>
  );
}
