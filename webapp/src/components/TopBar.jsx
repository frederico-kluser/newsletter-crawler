import ThemeToggle from './ThemeToggle.jsx';
import { STR } from '../strings.js';

/**
 * Barra fixa do topo: brand à esquerda, busca (children) no centro, custo/tema à direita.
 * O fundo translúcido + borda ganham presença ao rolar (ver .topbar[data-scrolled]).
 */
export default function TopBar({ theme, onToggleTheme, children, right = null, scrolled = false }) {
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
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
      </div>
    </header>
  );
}
