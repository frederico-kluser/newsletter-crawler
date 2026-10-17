import { defineTheme } from '@/components/motion-ui/ui-theme';

export default defineTheme({
  transitions: {
    snap: { stiffness: 1218, damping: 70 },
    ui: { stiffness: 320, damping: 34 },
    gentle: { stiffness: 120, damping: 22 },
    lively: { stiffness: 622, damping: 18 },
    ambient: { stiffness: 43, damping: 13 },
  },
  stagger: { tight: 0.035, base: 0.07, relaxed: 0.14 },
  travel: { hover: 3, enter: 18, section: 36 },
  inView: { amount: 0.3, once: true },
  reducedMotion: 'calm',
});
