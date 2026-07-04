import ThemeToggle from './ThemeToggle.jsx';
import LanguageToggle from './LanguageToggle.jsx';
import HelpButton from './HelpButton.jsx';
import { useStrings } from '../i18n.jsx';

/**
 * Barra fixa do topo: brand à esquerda, busca (children) no centro, controles à direita
 * (chave/custo + idioma + ajuda + tema). O fundo translúcido + borda ganham presença ao rolar.
 */
export default function TopBar({ theme, onToggleTheme, onHelp, children, right = null, scrolled = false }) {
  const STR = useStrings();
  return (
    <header className="topbar" data-scrolled={scrolled || undefined}>
      <div className="topbar-inner">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-text">
            <span className="brand-name">{STR.brand}</span>
            <span className="brand-tag">{STR.tagline}</span>
          </span>
        </div>
        <div className="topbar-center">{children}</div>
        <div className="topbar-right">
          {right}
          <LanguageToggle />
          <HelpButton onClick={onHelp} />
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
      </div>
    </header>
  );
}
