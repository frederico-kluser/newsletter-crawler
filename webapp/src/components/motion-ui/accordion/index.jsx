import { AnimatePresence, motion } from 'motion/react';
import { createContext, useCallback, useContext, useId, useMemo, useState } from 'react';
import { useMotionUITheme, useMotionUITransition } from '@/components/motion-ui/ui-theme';

export function nextOpenIds(current, value, singleOpen) {
  const isOpen = current.includes(value);
  if (singleOpen) return isOpen ? [] : [value];
  return isOpen ? current.filter((x) => x !== value) : [...current, value];
}

export function revealOpenIds(current, value, singleOpen) {
  if (singleOpen) return [value];
  return current.includes(value) ? current : [...current, value];
}

const AccordionRootContext = createContext(null);
const AccordionItemContext = createContext(null);

const PANEL_VARIANTS = {
  open: {
    height: 'auto',
    opacity: 1,
  },
  closed: {
    height: 0,
    opacity: 0,
  },
};

const CONTENT_VARIANTS = {
  open: { opacity: 1, filter: 'blur(0px)', y: 0 },
  closed: { opacity: 0, filter: 'blur(2px)', y: -4 },
};

const CONTENT_VARIANTS_REDUCED = {
  open: { opacity: 1 },
  closed: { opacity: 0 },
};

export function Accordion({
  multiple = true,
  defaultValue = [],
  value: controlledValue,
  onValueChange,
  className,
  children,
}) {
  const [uncontrolledValue, setUncontrolledValue] = useState(() => defaultValue ?? []);
  const openValues = controlledValue ?? uncontrolledValue;

  const toggle = useCallback(
    (itemValue) => {
      const next = nextOpenIds(openValues, itemValue, !multiple);
      if (controlledValue === undefined) setUncontrolledValue(next);
      onValueChange?.(next);
    },
    [openValues, multiple, controlledValue, onValueChange],
  );

  const ctx = useMemo(() => ({ openValues, toggle }), [openValues, toggle]);

  return (
    <AccordionRootContext.Provider value={ctx}>
      <div className={`mui-accordion${className ? ` ${className}` : ''}`}>{children}</div>
    </AccordionRootContext.Provider>
  );
}

export function AccordionItem({ value, className, children, ...rest }) {
  const root = useContext(AccordionRootContext);
  const baseId = useId();
  const open = root ? root.openValues.includes(value) : false;
  const triggerId = `${baseId}-trigger`;
  const panelId = `${baseId}-panel`;

  const itemCtx = useMemo(
    () => ({
      open,
      value,
      triggerId,
      panelId,
      toggle: () => root?.toggle(value),
    }),
    [open, value, triggerId, panelId, root],
  );

  return (
    <AccordionItemContext.Provider value={itemCtx}>
      <div
        data-state={open ? 'open' : 'closed'}
        className={`mui-accordion-item${className ? ` ${className}` : ''}`}
        {...rest}
      >
        {children}
      </div>
    </AccordionItemContext.Provider>
  );
}

export function AccordionTrigger({ children, indicator, badge, className }) {
  const item = useContext(AccordionItemContext);
  const open = item?.open ?? false;

  return (
    <div className="mui-accordion-header">
      <button
        id={item?.triggerId}
        type="button"
        aria-expanded={open}
        aria-controls={item?.panelId}
        onClick={item?.toggle}
        className={`mui-accordion-trigger${className ? ` ${className}` : ''}`}
      >
        <span className="mui-accordion-title">{children}</span>
        <span className="mui-accordion-meta">
          {badge != null && badge > 0 && <span className="mui-accordion-badge">{badge}</span>}
          {indicator ?? <AccordionChevron open={open} />}
        </span>
      </button>
    </div>
  );
}

export function AccordionPanel({ children, className }) {
  const item = useContext(AccordionItemContext);
  const { motionMode } = useMotionUITheme();
  const reduced = motionMode !== 'full';
  const uiTransition = useMotionUITransition('ui');
  const open = item?.open ?? false;

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          id={item?.panelId}
          role="region"
          aria-labelledby={item?.triggerId}
          className="mui-accordion-panel-wrap"
          initial="closed"
          animate="open"
          exit="closed"
          transition={reduced ? { duration: 0 } : { ...uiTransition }}
          variants={PANEL_VARIANTS}
        >
          <motion.div
            className={`mui-accordion-panel${className ? ` ${className}` : ''}`}
            variants={reduced ? CONTENT_VARIANTS_REDUCED : CONTENT_VARIANTS}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function AccordionChevron({ open, className }) {
  const { motionMode } = useMotionUITheme();
  const motionAllowed = motionMode === 'full';
  const snap = useMotionUITransition('snap');

  return (
    <motion.svg
      className={`mui-accordion-chevron${className ? ` ${className}` : ''}`}
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      animate={{ rotate: open ? 180 : 0 }}
      transition={motionAllowed ? { ...snap } : { duration: 0 }}
    >
      <path d="m6 9 6 6 6-6" />
    </motion.svg>
  );
}
