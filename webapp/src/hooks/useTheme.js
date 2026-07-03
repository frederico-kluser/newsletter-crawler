import { useCallback, useEffect, useState } from 'react';
import { getTheme, setTheme as persistTheme } from '../lib/storage.js';

function systemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Tema efetivo + toggle. O pré-paint do index.html já aplicou a escolha SALVA antes do 1º
 * paint; aqui mantemos data-theme em dia (inclusive quando a escolha nasce do sistema) e
 * persistimos só quando o usuário toca o toggle.
 */
export function useTheme() {
  const [theme, setThemeState] = useState(() => getTheme() || systemTheme());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // A transição suave de cores liga DEPOIS do 1º paint (evita "flash de transição" no boot).
  useEffect(() => {
    const id = requestAnimationFrame(() => document.documentElement.classList.add('theme-ready'));
    return () => cancelAnimationFrame(id);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      persistTheme(next);
      return next;
    });
  }, []);

  return { theme, toggle };
}
