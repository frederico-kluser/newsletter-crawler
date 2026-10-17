import {
  AnimatePresence,
  motion,
  useDragControls,
  useMotionValue,
  useTransform,
} from 'motion/react';
import { useEffect } from 'react';
import { useMotionUITheme, useMotionUITransition } from '@/components/motion-ui/ui-theme';

export function shouldDismissSheet(offsetY, velocityY, dismissOffset = 100, dismissVelocity = 780) {
  return offsetY > dismissOffset || velocityY > dismissVelocity;
}

/**
 * Motion UI Sheet — Bottom-sheet no mobile e modal editorial no desktop.
 * Arquitetura oficial do @motion/sheet em 2 camadas (a razão: entrada/saída animam
 * `transform` no WRAPPER externo, enquanto o arrasto usa a MotionValue `y` no PAINEL
 * interno — nunca os dois no mesmo elemento, senão a entrada pisca/teleporta):
 *   · wrapper externo  → coreografia de entrada/saída (transform + opacity);
 *   · painel interno   → drag-to-dismiss (alça = dragControls, corpo rola nativo);
 *   · scrim            → opacidade amarrada ao arrasto (useTransform y → 1..0.15).
 */
export function Sheet({
  open = true,
  onClose,
  ariaLabel,
  isMobile = true,
  overlayClassName = 'overlay',
  panelClassName = 'drawer',
  headClassName = 'drawer-head',
  header,
  children,
  footer,
}) {
  const { motionMode } = useMotionUITheme();
  const still = motionMode === 'off';
  const calm = motionMode === 'calm';
  const motionAllowed = motionMode === 'full';
  const gentle = useMotionUITransition('gentle');
  const dragControls = useDragControls();
  const y = useMotionValue(0);
  const scrimOpacity = useTransform(y, [0, 380], [1, 0.12]);

  useEffect(() => {
    if (!open) return undefined;
    y.set(0);
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose, y]);

  // mobile: desliza de baixo; desktop: sobe do centro com fade/scale
  const wrapInitial = still
    ? false
    : isMobile
      ? { transform: `translateY(${calm ? 0 : 46}px)`, opacity: calm ? 0 : 1 }
      : { transform: `translateY(${calm ? 0 : 22}px) scale(${calm ? 1 : 0.985})`, opacity: 0 };
  const wrapAnimate = isMobile
    ? { transform: 'translateY(0px)', opacity: 1 }
    : { transform: 'translateY(0px) scale(1)', opacity: 1 };
  const wrapExit = still
    ? undefined
    : isMobile
      ? { transform: `translateY(${calm ? 0 : 46}px)`, opacity: calm ? 0 : 1 }
      : { transform: `translateY(${calm ? 0 : 16}px) scale(${calm ? 1 : 0.985})`, opacity: 0 };

  const dragProps =
    isMobile && motionAllowed
      ? {
          drag: 'y',
          dragControls,
          dragListener: false,
          dragConstraints: { top: 0, bottom: 0 },
          dragElastic: { top: 0.08, bottom: 0.62 },
          onDragEnd: (_, info) => {
            if (shouldDismissSheet(info.offset.y, info.velocity.y)) onClose?.();
          },
        }
      : {};

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={`${overlayClassName} overlay-drift`}
          initial={still ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={still ? undefined : { opacity: 0 }}
          transition={{ ...gentle }}
          onClick={onClose}
        >
          <motion.div
            aria-hidden="true"
            className="sheet-scrim"
            style={isMobile && motionAllowed ? { opacity: scrimOpacity } : undefined}
          />
          <motion.div
            className="sheet-positioner"
            initial={wrapInitial}
            animate={wrapAnimate}
            exit={wrapExit}
            transition={{ ...gentle }}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label={ariaLabel}
              className={panelClassName}
              onClick={(e) => e.stopPropagation()}
              style={isMobile ? { y, touchAction: 'none' } : undefined}
              {...dragProps}
            >
              <div
                className={headClassName}
                style={isMobile ? { touchAction: 'none', cursor: motionAllowed ? 'grab' : undefined } : undefined}
                onPointerDown={isMobile && motionAllowed ? (e) => dragControls.start(e) : undefined}
              >
                {isMobile && <div className="drawer-handle" aria-hidden="true" />}
                {header}
              </div>
              {children}
              {footer}
            </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
