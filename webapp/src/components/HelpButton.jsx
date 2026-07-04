import { motion } from 'motion/react';
import { useStrings } from '../i18n.jsx';
import { springs } from '../motion/transitions.js';

const HelpIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9.3" />
    <path d="M9.2 9.2a3 3 0 0 1 5.7 1c0 2-3 2.3-3 4.1" />
    <circle cx="11.9" cy="17.4" r="0.6" fill="currentColor" stroke="none" />
  </svg>
);

/** Botão de ajuda (topbar): reabre o tour de introdução a qualquer momento. */
export default function HelpButton({ onClick }) {
  const STR = useStrings();
  return (
    <motion.button
      type="button"
      className="icon-btn"
      onClick={onClick}
      whileHover={{ scale: 1.06 }}
      whileTap={{ scale: 0.92 }}
      transition={springs.snappy}
      aria-label={STR.helpTitle}
      title={STR.helpTitle}
    >
      <HelpIcon />
    </motion.button>
  );
}
