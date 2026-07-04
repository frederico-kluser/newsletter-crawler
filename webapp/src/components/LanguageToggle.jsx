import { motion } from 'motion/react';
import { useLocale } from '../i18n.jsx';
import { LOCALE_NAME } from '../strings.js';
import { springs } from '../motion/transitions.js';

const LOCALES = ['pt', 'en'];

/**
 * Seletor de idioma compacto (PT | EN). Segmented com "pílula" que desliza entre as opções
 * (layoutId) — mesma linguagem de movimento do app. 2 idiomas: o resto do mundo cai em inglês
 * (ver resolveLocale/i18n.jsx), então bastam dois segmentos. `layoutId` é parametrizável porque
 * há DUAS instâncias vivas ao mesmo tempo (topbar + tutorial) e o layoutId precisa ser único.
 */
export default function LanguageToggle({ layoutId = 'lang-pill' }) {
  const { locale, setLocale, strings: STR } = useLocale();
  return (
    <div className="lang-toggle" role="group" aria-label={STR.langLabel}>
      {LOCALES.map((l) => {
        const active = l === locale;
        return (
          <button
            key={l}
            type="button"
            className="lang-opt"
            data-active={active || undefined}
            aria-pressed={active}
            aria-label={STR.langSwitchTo(LOCALE_NAME[l])}
            title={STR.langSwitchTo(LOCALE_NAME[l])}
            onClick={() => setLocale(l)}
          >
            {active && (
              <motion.span
                className="lang-pill"
                layoutId={layoutId}
                transition={springs.snappy}
                aria-hidden="true"
              />
            )}
            <span className="lang-opt-label">{l.toUpperCase()}</span>
          </button>
        );
      })}
    </div>
  );
}
