// @motion/ui-theme — vocabulário unificado de movimento do Motion UI.
// Define as 5 transições semânticas (snap, ui, gentle, lively, ambient),
// tokens de stagger/travel/inView, resolução de reducedMotion ("calm" | "off")
// e emissão de variáveis CSS (--motion-ui-transition-*).

import { createGeneratorEasing, generateLinearEasing, spring } from 'motion';
import { useReducedMotion } from 'motion/react';
import { createContext, createElement, useContext, useEffect, useMemo } from 'react';

function transition(duration, stiffness, damping, ease) {
  return { type: 'spring', duration, stiffness, damping, ease };
}

const defaultOut = [0.22, 1, 0.36, 1];
const defaultInOut = [0.65, 0, 0.35, 1];

export const defaultTheme = {
  transitions: {
    snap: transition(0.15, 1218.4696791468346, 69.81317007977319, defaultOut),
    ui: transition(0.3, 304.61741978670864, 33.16125578789226, defaultOut),
    gentle: transition(0.5, 109.6622711232151, 19.896753472735355, defaultOut),
    lively: transition(0.21, 621.668203646344, 17.453292519943293, defaultOut),
    ambient: transition(0.8, 42.8368246575059, 13.089969389957473, defaultInOut),
  },
  stagger: { tight: 0.04, base: 0.08, relaxed: 0.15 },
  travel: { hover: 4, enter: 24, section: 48 },
  inView: { amount: 0.35, once: true },
  reducedMotion: 'calm',
};

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const overrideValue = override[key];
    if (overrideValue === undefined) continue;
    result[key] = deepMerge(base[key], overrideValue);
  }
  return result;
}

export function defineTheme(config = {}) {
  return structuredClone(deepMerge(defaultTheme, config));
}

export function resolveReducedMotion(theme, prefersReducedMotion) {
  if (!prefersReducedMotion) {
    return { strategy: 'full', animate: true, travel: true, opacityOnly: false };
  }
  if (theme.reducedMotion === 'off') {
    return { strategy: 'off', animate: false, travel: false, opacityOnly: false };
  }
  return { strategy: 'calm', animate: true, travel: false, opacityOnly: true };
}

function num(value) {
  return Number(value.toFixed(4)).toString();
}

function cubicBezier(points) {
  return `cubic-bezier(${points.map(num).join(', ')})`;
}

export function transitionToLinear(token) {
  const easing = createGeneratorEasing(
    { stiffness: token.stiffness, damping: token.damping },
    100,
    spring,
  );
  return {
    easing: generateLinearEasing(easing.ease, easing.duration * 1000),
    duration: easing.duration,
  };
}

export function themeToCssVars(theme) {
  const vars = {};
  for (const name of Object.keys(theme.transitions)) {
    const token = theme.transitions[name];
    vars[`--motion-ui-transition-${name}`] = cubicBezier(token.ease);
    vars[`--motion-ui-transition-${name}-duration`] = `${num(token.duration)}s`;
    try {
      const { easing, duration } = transitionToLinear(token);
      vars[`--motion-ui-transition-${name}-spring`] = easing;
      vars[`--motion-ui-transition-${name}-spring-duration`] = `${num(duration)}s`;
    } catch {
      // Fallback caso o ambiente não suporte geração linear
    }
  }
  for (const [name, value] of Object.entries(theme.stagger)) {
    vars[`--motion-ui-stagger-${name}`] = `${num(value)}s`;
  }
  for (const [name, value] of Object.entries(theme.travel)) {
    vars[`--motion-ui-travel-${name}`] = `${num(value)}px`;
  }
  return vars;
}

const UIThemeContext = createContext(null);

export function MotionUIThemeProvider({ theme, children }) {
  const value = theme ?? defaultTheme;

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const vars = themeToCssVars(value);
    for (const [k, v] of Object.entries(vars)) {
      root.style.setProperty(k, v);
    }
  }, [value]);

  return createElement(UIThemeContext.Provider, { value }, children);
}

function useThemeContext() {
  return useContext(UIThemeContext) ?? defaultTheme;
}

export function useMotionUITheme() {
  const theme = useThemeContext();
  const prefersReducedMotion = !!useReducedMotion();
  const motionMode = resolveReducedMotion(theme, prefersReducedMotion).strategy;
  return useMemo(() => ({ ...theme, motionMode }), [theme, motionMode]);
}

export function useMotionUITransition(name = 'ui') {
  const theme = useThemeContext();
  const token = theme.transitions[name] ?? theme.transitions.ui;
  return useMemo(() => {
    const { duration, stiffness, damping, ease } = token;
    return {
      type: 'spring',
      stiffness,
      damping,
      duration,
      ease,
      opacity: { type: 'tween', duration, ease: 'linear', inherit: true },
    };
  }, [token]);
}
