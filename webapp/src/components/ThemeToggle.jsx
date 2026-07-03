import { AnimatePresence, motion } from 'motion/react';
import { STR } from '../strings.js';
import { springs } from '../motion/transitions.js';

const Sun = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4.4" />
    <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19" />
  </svg>
);
const Moon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20.3 14.6A8.6 8.6 0 0 1 9.4 3.7a.7.7 0 0 0-.9-.9 9.9 9.9 0 1 0 12.7 12.7.7.7 0 0 0-.9-.9Z" />
  </svg>
);

/** Alterna claro/escuro com troca animada do ícone (rotate+fade). */
export default function ThemeToggle({ theme, onToggle }) {
  const dark = theme === 'dark';
  return (
    <motion.button
      type="button"
      className="icon-btn"
      onClick={onToggle}
      whileHover={{ scale: 1.06 }}
      whileTap={{ scale: 0.92 }}
      transition={springs.snappy}
      aria-label={dark ? STR.themeToLight : STR.themeToDark}
      title={dark ? STR.themeToLight : STR.themeToDark}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={dark ? 'moon' : 'sun'}
          className="icon-btn-glyph"
          initial={{ rotate: -50, opacity: 0, scale: 0.6 }}
          animate={{ rotate: 0, opacity: 1, scale: 1 }}
          exit={{ rotate: 50, opacity: 0, scale: 0.6 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
        >
          {dark ? <Moon /> : <Sun />}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}
