import { motion } from 'motion/react';
import { createContext, useContext, useMemo, useState } from 'react';
import { useMotionUITheme, useMotionUITransition } from '@/components/motion-ui/ui-theme';

export const ARROW_NUDGE_VARIANT = 'nudge';
const ArrowNudgeActiveContext = createContext(false);

function isFocusVisibleTarget(target) {
  return target instanceof HTMLElement && target.matches(':focus-visible');
}

export function useArrowNudgeActive() {
  const { motionMode } = useMotionUITheme();
  const motionAllowed = motionMode === 'full';
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const active = motionAllowed && (hovered || focused);

  const gestureProps = useMemo(() => {
    if (!motionAllowed) return {};
    return {
      onHoverStart: () => setHovered(true),
      onHoverEnd: () => setHovered(false),
      onFocus: (event) => {
        if (isFocusVisibleTarget(event.currentTarget)) setFocused(true);
      },
      onBlur: () => setFocused(false),
    };
  }, [motionAllowed]);

  return { active, gestureProps };
}

export function ArrowNudgeActiveProvider({ active, children }) {
  return (
    <ArrowNudgeActiveContext.Provider value={active}>
      {children}
    </ArrowNudgeActiveContext.Provider>
  );
}

export function ArrowIcon({ size = 14, className, upRight = false }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {upRight ? (
        <>
          <path d="M7 17 17 7" />
          <path d="M8 7h9v9" />
        </>
      ) : (
        <>
          <path d="M5 12h14" />
          <path d="m12 5 7 7-7 7" />
        </>
      )}
    </svg>
  );
}

export function ArrowNudge({ size = 14, className, active: activeProp, upRight = false }) {
  const snap = useMotionUITransition('snap');
  const uiTheme = useMotionUITheme();
  const motionAllowed = uiTheme.motionMode === 'full';
  const inheritedActive = useContext(ArrowNudgeActiveContext);
  const active = activeProp ?? inheritedActive;
  const shift = motionAllowed ? uiTheme.travel.hover : 0;

  return (
    <motion.span
      className={`mui-arrow-nudge${className ? ` ${className}` : ''}`}
      initial={false}
      animate={
        active
          ? { x: shift, y: upRight ? -shift * 0.65 : 0 }
          : { x: 0, y: 0 }
      }
      transition={{ ...snap }}
      aria-hidden="true"
    >
      <ArrowIcon size={size} upRight={upRight} />
    </motion.span>
  );
}

export function ArrowLink({
  children,
  href,
  tone = 'muted',
  target,
  rel,
  onClick,
  className,
  upRight = false,
  ref,
}) {
  const { active, gestureProps } = useArrowNudgeActive();
  return (
    <ArrowNudgeActiveProvider active={active}>
      <motion.a
        ref={ref}
        href={href}
        target={target}
        rel={rel}
        onClick={onClick}
        data-tone={tone}
        className={`mui-arrow-link${className ? ` ${className}` : ''}`}
        {...gestureProps}
      >
        <span>{children}</span>
        <ArrowNudge upRight={upRight} />
      </motion.a>
    </ArrowNudgeActiveProvider>
  );
}
