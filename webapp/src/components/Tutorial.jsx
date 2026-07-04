import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { fades, springs } from '../motion/transitions.js';
import { useStrings } from '../i18n.jsx';
import LanguageToggle from './LanguageToggle.jsx';

// Ícone de cada passo (as strings guardam só o id; o SVG mora aqui). Traço fino estilo SF Symbols.
const ICONS = {
  sparkle: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3.2l1.8 5 5 1.8-5 1.8-1.8 5-1.8-5-5-1.8 5-1.8z" />
      <path d="M18.7 3.4l.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6z" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="6.4" />
      <path d="m20 20-3.6-3.6" />
    </svg>
  ),
  sliders: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h9M17 7h3" />
      <circle cx="15" cy="7" r="2" />
      <path d="M4 12h3M11 12h9" />
      <circle cx="9" cy="12" r="2" />
      <path d="M4 17h11M19 17h1" />
      <circle cx="17" cy="17" r="2" />
    </svg>
  ),
  cards: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="4" width="12" height="16" rx="2" />
      <path d="M7 9h5M7 12h5.5M7 15h3.5" />
      <path d="M18.5 7.6A2 2 0 0 1 20 9.5v8a2.5 2.5 0 0 1-2.5 2.5H9.2" />
    </svg>
  ),
  rocket: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 14c-1.5 1.5-2 5-2 5s3.5-.5 5-2" />
      <path d="M14.4 4.6C17 4 19.5 4.5 20 5s1 3-.4 5.6c-1.6 2.7-6.1 6-6.1 6l-4-4s3.4-4.5 5.1-6.6c.3-.4.6-.9 1-1.4z" />
      <circle cx="14.4" cy="9.6" r="1.4" />
    </svg>
  ),
};

// Slide horizontal por direção; sob prefers-reduced-motion o MotionConfig troca o x por crossfade.
const stepVariants = {
  enter: (dir) => ({ opacity: 0, x: dir > 0 ? 44 : -44 }),
  center: { opacity: 1, x: 0 },
  exit: (dir) => ({ opacity: 0, x: dir > 0 ? -44 : 44 }),
};

const FOCUSABLE = 'button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])';

/**
 * Tour de introdução estilo "Welcome" da Apple: sheet central com ícone, título, texto curto,
 * bolinhas de progresso e Pular / Voltar / Continuar. Rápido e OPCIONAL (HIG). Acessível: role
 * dialog + aria-modal, focus trap com Tab, ←/→ navega, Esc fecha, foco volta ao gatilho ao sair.
 * `onClose` (no App) marca como visto e desmonta.
 */
export default function Tutorial({ onClose }) {
  const STR = useStrings();
  const steps = STR.tutorialSteps;
  const [[index, dir], setStep] = useState([0, 0]);
  const cardRef = useRef(null);
  const primaryRef = useRef(null);
  const returnFocusRef = useRef(null);

  const total = steps.length;
  const last = index === total - 1;
  const step = steps[index];

  const go = (target, d) => setStep([Math.max(0, Math.min(total - 1, target)), d]);

  // Montagem: guarda o foco de origem, trava o scroll do body, foca o botão primário. No
  // desmonte, devolve o scroll e o foco pro gatilho (botão de ajuda / boot).
  useEffect(() => {
    returnFocusRef.current = document.activeElement;
    document.body.style.overflow = 'hidden';
    primaryRef.current?.focus();
    return () => {
      document.body.style.overflow = '';
      const el = returnFocusRef.current;
      if (el && typeof el.focus === 'function') el.focus();
    };
  }, []);

  // Teclado global: Esc fecha, ←/→ navega, Tab fica preso no card (Enter é do botão focado).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (last) onClose();
        else go(index + 1, 1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (index > 0) go(index - 1, -1);
      } else if (e.key === 'Tab') {
        const card = cardRef.current;
        if (!card) return;
        const nodes = card.querySelectorAll(FOCUSABLE);
        if (!nodes.length) return;
        const first = nodes[0];
        const lastNode = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          lastNode.focus();
        } else if (!e.shiftKey && document.activeElement === lastNode) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, last, total, onClose]);

  return (
    <motion.div
      className="overlay overlay-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={fades.base}
      onClick={onClose}
    >
      <motion.div
        ref={cardRef}
        className="tutorial-card"
        role="dialog"
        aria-modal="true"
        aria-label={STR.tutorialAria}
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.94, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={springs.sheet}
      >
        <div className="tutorial-head">
          <LanguageToggle layoutId="lang-pill-tut" />
          <button type="button" className="icon-btn tutorial-close" onClick={onClose} aria-label={STR.close}>
            ✕
          </button>
        </div>

        <div className="tutorial-stage">
          {/* mode="wait": UM passo por vez (o que sai desliza p/ um lado, o que entra vem do outro).
              Sem isso, cliques rápidos empilham nós em exit no mesmo grid-cell e sujam o focus trap. */}
          <AnimatePresence mode="wait" custom={dir} initial={false}>
            <motion.div
              key={index}
              className="tutorial-step"
              custom={dir}
              variants={stepVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={springs.gentle}
            >
              <div className="tutorial-icon" aria-hidden="true">
                {ICONS[step.icon] || ICONS.sparkle}
              </div>
              <h2 className="tutorial-title">{step.title}</h2>
              <p className="tutorial-body">{step.body}</p>
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="tutorial-dots" role="group" aria-label={STR.tutorialStep(index + 1, total)}>
          {steps.map((_, i) => (
            <button
              key={i}
              type="button"
              className="tutorial-dot"
              data-active={i === index || undefined}
              aria-label={STR.tutorialGoTo(i + 1)}
              aria-current={i === index ? 'step' : undefined}
              onClick={() => go(i, i > index ? 1 : -1)}
            />
          ))}
        </div>

        <div className="tutorial-actions">
          <button type="button" className="btn tutorial-skip" onClick={onClose}>
            {STR.tutorialSkip}
          </button>
          <div className="tutorial-actions-right">
            {index > 0 && (
              <button type="button" className="btn" onClick={() => go(index - 1, -1)}>
                {STR.tutorialBack}
              </button>
            )}
            <button
              ref={primaryRef}
              type="button"
              className="btn btn-primary"
              onClick={() => (last ? onClose() : go(index + 1, 1))}
            >
              {last ? STR.tutorialDone : STR.tutorialNext}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
