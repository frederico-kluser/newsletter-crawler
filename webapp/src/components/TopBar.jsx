import {
  ShrinkHeader,
  ShrinkHeaderFill,
  ShrinkHeaderRow,
} from '@/components/motion-ui/shrink-header';
import ThemeToggle from './ThemeToggle.jsx';
import LanguageToggle from './LanguageToggle.jsx';
import HelpButton from './HelpButton.jsx';
import { useStrings } from '../i18n.jsx';

/**
 * Barra fixa do topo sobre o primitivo ShrinkHeader do Motion+ UI:
 * brand editorial à esquerda, busca híbrida no centro, controles e atalho ⌘K à direita.
 */
export default function TopBar({
  theme,
  onToggleTheme,
  onHelp,
  onOpenCommandPalette,
  children,
  right = null,
  scrolled = false,
}) {
  const STR = useStrings();
  return (
    <ShrinkHeader scrolled={scrolled} condenseDistance={96}>
      <ShrinkHeaderFill />
      <ShrinkHeaderRow>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <span className="brand-mark-core" />
          </span>
          <span className="brand-text">
            <span className="brand-name">{STR.brand}</span>
            <span className="brand-tag">{STR.tagline}</span>
          </span>
        </div>
        <div className="topbar-center">{children}</div>
        <div className="topbar-right">
          {onOpenCommandPalette && (
            <button
              type="button"
              className="cmdk-trigger-btn"
              onClick={onOpenCommandPalette}
              title={`${STR.cmdkTrigger} (⌘K)`}
              aria-label={`${STR.cmdkTrigger} (⌘K)`}
              aria-keyshortcuts="Meta+K Control+K"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z" />
              </svg>
              <kbd className="cmdk-kbd">⌘K</kbd>
            </button>
          )}
          {right}
          <LanguageToggle />
          <HelpButton onClick={onHelp} />
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
      </ShrinkHeaderRow>
    </ShrinkHeader>
  );
}
