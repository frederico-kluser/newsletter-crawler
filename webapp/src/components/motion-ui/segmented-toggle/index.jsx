import { motion } from 'motion/react';
import { createContext, useContext, useId, useMemo } from 'react';
import { useMotionUITheme, useMotionUITransition } from '@/components/motion-ui/ui-theme';

const SegmentedToggleContext = createContext(null);

const PRESS_SCALE = 0.96;
const THUMB_STRETCH = [1, 1.06, 1];
const STRETCH_DURATION = 0.28;

export function SegmentedToggle({
  value,
  onChange,
  ariaLabel,
  layoutId,
  className,
  children,
}) {
  const generatedId = useId();
  const snap = useMotionUITransition('snap');
  const { motionMode } = useMotionUITheme();
  const motionAllowed = motionMode === 'full';

  const ctx = useMemo(
    () => ({
      value,
      onChange,
      layoutId: layoutId ?? `segmented-toggle-${generatedId}`,
      indicatorTransition: snap,
      animateIndicator: motionAllowed,
    }),
    [value, onChange, layoutId, generatedId, snap, motionAllowed],
  );

  return (
    <SegmentedToggleContext.Provider value={ctx}>
      <div
        role="group"
        aria-label={ariaLabel}
        className={`seg${className ? ` ${className}` : ''}`}
      >
        {children}
      </div>
    </SegmentedToggleContext.Provider>
  );
}

export function SegmentedToggleOption({ value, children, className }) {
  const ctx = useContext(SegmentedToggleContext);
  const selected = ctx?.value === value;

  return (
    <motion.button
      type="button"
      className={`seg-item${className ? ` ${className}` : ''}`}
      data-on={selected || undefined}
      aria-pressed={selected}
      onClick={() => {
        if (value !== ctx?.value) ctx?.onChange?.(value);
      }}
      whileTap={ctx?.animateIndicator ? { scale: PRESS_SCALE } : undefined}
      transition={ctx?.indicatorTransition}
    >
      {selected && (
        <motion.span
          layoutId={ctx.layoutId}
          className="seg-thumb"
          initial={ctx.animateIndicator ? { scaleX: 1 } : false}
          animate={ctx.animateIndicator ? { scaleX: THUMB_STRETCH } : undefined}
          transition={
            ctx.animateIndicator
              ? {
                  ...ctx.indicatorTransition,
                  scaleX: { duration: STRETCH_DURATION, times: [0, 0.35, 1], ease: 'easeOut' },
                }
              : { duration: 0 }
          }
          aria-hidden="true"
        />
      )}
      <span className="seg-label">{children}</span>
    </motion.button>
  );
}
