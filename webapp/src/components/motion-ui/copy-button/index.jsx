import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useMotionUITheme, useMotionUITransition } from '@/components/motion-ui/ui-theme';

function buildSwapMotion(still, calm, swapTransition) {
  const fade = {
    duration: swapTransition.opacity.duration,
    ease: swapTransition.opacity.ease,
  };
  if (still) {
    return {
      initial: false,
      animate: { opacity: 1, filter: 'blur(0px)' },
      exit: { opacity: 0 },
      transition: { duration: 0 },
    };
  }
  if (calm) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: fade,
    };
  }
  return {
    initial: { opacity: 0, filter: 'blur(4px)', scale: 0.92 },
    animate: { opacity: 1, filter: 'blur(0px)', scale: 1 },
    exit: { opacity: 0, filter: 'blur(4px)', scale: 0.92 },
    transition: { ...swapTransition },
  };
}

export function CopyButton({
  value,
  variant = 'label',
  children = 'Copy',
  copiedText = 'Copied',
  label = 'Copy to clipboard',
  copiedLabel = 'Copied to clipboard',
  resetMs = 2000,
  onCopy,
  disabled,
  className,
  ref,
}) {
  const { motionMode } = useMotionUITheme();
  const still = motionMode === 'off';
  const calm = motionMode === 'calm';
  const motionAllowed = motionMode === 'full';
  const snap = useMotionUITransition('snap');
  const swapTransition = useMotionUITransition('ui');
  const [copied, setCopied] = useState(false);
  const resetRef = useRef(null);

  useEffect(() => () => clearTimeout(resetRef.current), []);

  const handleCopy = async (e) => {
    e?.stopPropagation?.();
    try {
      await navigator.clipboard?.writeText(value);
    } catch {
      // Ambientes restritos sem clipboard API ainda mostram o feedback visual
    }
    setCopied(true);
    onCopy?.(value);
    clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => setCopied(false), resetMs);
  };

  const isIcon = variant === 'icon';
  const glyphSize = isIcon ? 15 : 13;
  const swapMotion = buildSwapMotion(still, calm, swapTransition);

  return (
    <motion.button
      ref={ref}
      type="button"
      data-variant={variant}
      data-copied={copied || undefined}
      className={`mui-copy-btn${className ? ` ${className}` : ''}`}
      onClick={handleCopy}
      disabled={disabled}
      aria-label={copied ? copiedLabel : label}
      title={copied ? copiedLabel : label}
      layout={!isIcon && motionAllowed ? true : undefined}
      whileTap={motionAllowed ? { scale: 0.94 } : undefined}
      transition={{ ...snap }}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={copied ? 'copied' : 'idle'}
          className="mui-copy-inner"
          layout={!isIcon && motionAllowed ? 'position' : undefined}
          {...swapMotion}
        >
          {copied ? <CheckIcon size={glyphSize} /> : <ClipboardIcon size={glyphSize} />}
          {!isIcon && <span>{copied ? copiedText : children}</span>}
        </motion.span>
      </AnimatePresence>
      <span aria-live="polite" className="sr-only">
        {copied ? copiedLabel : ''}
      </span>
    </motion.button>
  );
}

function CheckIcon({ size }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 12l5 5L20 6" />
    </svg>
  );
}

function ClipboardIcon({ size }) {
  return (
    <svg
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
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </svg>
  );
}
