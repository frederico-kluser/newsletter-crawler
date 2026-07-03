import { useEffect, useState } from 'react';

/** Ecoa `value` após `delay` ms parado — evita refiltrar 600 artigos a cada tecla. */
export function useDebouncedValue(value, delay = 180) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
