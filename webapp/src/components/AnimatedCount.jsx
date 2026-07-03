import { useEffect, useRef } from 'react';
import { animate, motion, useMotionValue, useTransform } from 'motion/react';

/**
 * Número que "conta" até o valor novo (useMotionValue + animate — sem re-render por frame;
 * o motion.span renderiza o MotionValue direto). aria-live no wrapper anuncia o valor final.
 */
export default function AnimatedCount({ value, format = (v) => Math.round(v).toLocaleString('pt-BR') }) {
  const mv = useMotionValue(value);
  // forma argless do useTransform (a forma com closure de argumento está deprecada)
  const text = useTransform(() => format(mv.get()));
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      mv.set(value); // 1º valor não anima (evita contar do 0 no boot de cada card/badge)
      return undefined;
    }
    const controls = animate(mv, value, { duration: 0.5, ease: 'easeOut' });
    return () => controls.stop();
  }, [value, mv]);

  return (
    <span aria-live="polite">
      <motion.span>{text}</motion.span>
    </span>
  );
}
