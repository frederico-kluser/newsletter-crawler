import { motion, useScroll, useSpring, useTransform } from 'motion/react';
import { createContext, useContext } from 'react';
import { useMotionUITheme } from '@/components/motion-ui/ui-theme';

const ShrinkHeaderContext = createContext(null);

export function ShrinkHeader({
  children,
  condenseDistance = 120,
  scrolled = false,
  className,
}) {
  const uiTheme = useMotionUITheme();
  const motionAllowed = uiTheme.motionMode === 'full';
  const { scrollY } = useScroll();

  const condenseRaw = useTransform(
    scrollY,
    [0, condenseDistance],
    motionAllowed ? [0, 1] : [1, 1],
  );
  const condense = useSpring(condenseRaw, uiTheme.transitions.gentle);
  const borderOpacity = useTransform(condense, [0, 0.25, 1], [0, 0.75, 1]);

  return (
    <ShrinkHeaderContext.Provider value={{ condense, borderOpacity, motionAllowed }}>
      <header
        data-scrolled={scrolled || undefined}
        className={`topbar${className ? ` ${className}` : ''}`}
      >
        {children}
      </header>
    </ShrinkHeaderContext.Provider>
  );
}

export function ShrinkHeaderFill({ className, style }) {
  const ctx = useContext(ShrinkHeaderContext);
  return (
    <motion.div
      aria-hidden="true"
      className={`topbar-backdrop${className ? ` ${className}` : ''}`}
      style={{
        ...style,
        opacity: ctx ? ctx.borderOpacity : 1,
      }}
    />
  );
}

export function ShrinkHeaderRow({ children, className }) {
  return (
    <div className={`topbar-inner${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  );
}

export function useCondenseProgress() {
  return useContext(ShrinkHeaderContext)?.condense;
}
