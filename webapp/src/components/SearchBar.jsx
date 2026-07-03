import { useState } from 'react';
import { STR } from '../strings.js';

const SearchIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.8-3.8" />
  </svg>
);

/**
 * Busca IA da topbar. Digitar NÃO filtra — só Enter/botão dispara (a busca é paga, por IA;
 * paridade com a web UI do CLI). O toggle "Busca profunda" troca lote→por-artigo.
 */
export default function SearchBar({ onSubmit, busy }) {
  const [value, setValue] = useState('');
  const [deep, setDeep] = useState(false);

  return (
    <form
      className="searchbar"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value, deep);
      }}
    >
      <span className="searchbar-icon" aria-hidden="true">
        <SearchIcon />
      </span>
      <input
        type="search"
        className="searchbar-input"
        placeholder={STR.searchPlaceholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={STR.searchPlaceholder}
      />
      <label className="deep-toggle" title={deep ? STR.deepHint : STR.softHint}>
        <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} />
        <span>{STR.deepToggle}</span>
      </label>
      <button type="submit" className="btn btn-primary searchbar-go" disabled={busy || !value.trim()}>
        {busy ? STR.searching : STR.searchButton}
      </button>
    </form>
  );
}
