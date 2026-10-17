import { motion } from 'motion/react';
import { useMotionUITheme, useMotionUITransition } from '@/components/motion-ui/ui-theme';

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function ProgressBar({
  value,
  reveal = true,
  revealed = true,
  index = 0,
  referenceTick,
  highlight = true,
  tone,
  size = 'md',
  progressbar = true,
  'aria-label': ariaLabel,
  label,
  valueLabel,
  labelPlacement = 'top',
  shine = false,
  className,
  ref,
}) {
  const uiTheme = useMotionUITheme();
  const uiTransition = useMotionUITransition('ui');
  const motionMode = uiTheme.motionMode;
  const still = motionMode === 'off';
  const calm = motionMode === 'calm';
  const share = clamp01(value);

  const hasLabelRow = label != null || valueLabel != null;
  const labelRow = hasLabelRow ? (
    <div className="mui-progress-labels">
      <span className="mui-progress-label">{label}</span>
      {valueLabel != null ? <span className="mui-progress-val">{valueLabel}</span> : null}
    </div>
  ) : null;

  return (
    <div ref={ref} className={`mui-progress${className ? ` ${className}` : ''}`}>
      {labelPlacement === 'top' ? labelRow : null}
      <div
        role={progressbar ? 'progressbar' : undefined}
        aria-label={progressbar ? ariaLabel : undefined}
        aria-valuemin={progressbar ? 0 : undefined}
        aria-valuemax={progressbar ? 100 : undefined}
        aria-valuenow={progressbar ? Math.round(share * 100) : undefined}
        data-size={size}
        className="mui-progress-track"
      >
        <motion.div
          className="mui-progress-fill"
          data-highlight={highlight || undefined}
          style={tone ? { backgroundColor: tone } : undefined}
          initial={reveal && !still && !calm ? { scaleX: 0 } : false}
          animate={{ scaleX: revealed ? share : 0 }}
          transition={
            still
              ? { duration: 0 }
              : {
                  ...uiTransition,
                  delay: index * uiTheme.stagger.base,
                }
          }
        >
          {shine && <span className="mui-progress-shine" aria-hidden="true" />}
        </motion.div>
        {referenceTick !== undefined && (
          <span
            aria-hidden="true"
            className="mui-progress-tick"
            style={{ left: `${clamp01(referenceTick) * 100}%` }}
          />
        )}
      </div>
      {labelPlacement === 'bottom' ? labelRow : null}
    </div>
  );
}
