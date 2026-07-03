// Vocabulário ÚNICO de springs/fades do app — os componentes importam daqui, nunca definem
// transição inline solta (consistência de física = identidade de movimento).
// visualDuration/bounce (Motion): duração percebida até "assentar visualmente" + quique.
export const springs = {
  /** chips, segmented, botões — resposta imediata, quique mínimo */
  snappy: { type: 'spring', visualDuration: 0.25, bounce: 0.15 },
  /** cards, layout FLIP do grid — presença suave */
  gentle: { type: 'spring', visualDuration: 0.4, bounce: 0.2 },
  /** sheet de preview, drawer de filtros — massa maior, sem elasticidade excessiva */
  sheet: { type: 'spring', visualDuration: 0.45, bounce: 0.12 },
};

export const fades = {
  fast: { duration: 0.15, ease: 'easeOut' },
  base: { duration: 0.25, ease: 'easeOut' },
};
