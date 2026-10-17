// Vocabulário ÚNICO de springs/fades do app — sincronizado com o @motion/ui-theme (motion.theme.js).
import motionTheme from '../motion.theme.js';

const { snap, ui, gentle, lively, ambient } = motionTheme.transitions;

export const springs = {
  /** chips, segmented, botões — resposta imediata (token snap) */
  snappy: {
    type: 'spring',
    stiffness: snap.stiffness,
    damping: snap.damping,
  },
  /** cards, reveals, layout FLIP do grid — presença fluida (token ui) */
  gentle: {
    type: 'spring',
    stiffness: ui.stiffness,
    damping: ui.damping,
  },
  /** sheet de preview, drawer de filtros — superfície ampla (token gentle) */
  sheet: {
    type: 'spring',
    stiffness: gentle.stiffness,
    damping: gentle.damping,
  },
  /** contadores, celebrações, badges — elástico controlado (token lively) */
  lively: {
    type: 'spring',
    stiffness: lively.stiffness,
    damping: lively.damping,
  },
  /** pulsos de fundo contínuos (token ambient) */
  ambient: {
    type: 'spring',
    stiffness: ambient.stiffness,
    damping: ambient.damping,
  },
};

export const fades = {
  fast: { duration: snap.duration, ease: snap.ease },
  base: { duration: ui.duration, ease: ui.ease },
};
