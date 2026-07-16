import { useState } from 'react';
import { fmtDateTime } from '../strings.js';
import { useStrings } from '../i18n.jsx';
import { usePlayer } from '../player.jsx';
import PlayButton from './PlayButton.jsx';

const SearchIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.8-3.8" />
  </svg>
);
const SparkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2l1.9 5.6L19.5 9l-4.5 3.3L16.4 18 12 14.7 7.6 18l1.4-5.7L4.5 9l5.6-1.4L12 2z" />
  </svg>
);

/**
 * Busca híbrida: DIGITAR filtra a lista localmente por texto (sempre, sem chave, sem custo);
 * o botão "IA" (ou Enter) dispara a busca semântica — que pede a chave se faltar, mas NÃO
 * bloqueia o filtro por texto já aplicado. O cadeado no botão sinaliza "requer chave".
 */
export default function SearchBar({ text, onTextChange, onAiSearch, aiBusy, hasKey, recents = [], onPickRecent, activeId }) {
  const STR = useStrings();
  const player = usePlayer();
  const [deep, setDeep] = useState(false);
  const [focused, setFocused] = useState(false);
  const showRecents = focused && !text.trim() && recents.length > 0;
  return (
    <form
      className="searchbar"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (!aiBusy && text.trim()) onAiSearch(deep);
      }}
    >
      <span className="searchbar-icon" aria-hidden="true">
        <SearchIcon />
      </span>
      <input
        type="search"
        className="searchbar-input"
        placeholder={STR.searchPlaceholder}
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-label={STR.searchPlaceholder}
      />
      {showRecents && (
        // onMouseDown preventDefault: clicar num item NÃO tira o foco antes do onClick disparar
        <div className="searchbar-recents" onMouseDown={(e) => e.preventDefault()}>
          <span className="searchbar-recents-label">{STR.historyRecent}</span>
          {recents.slice(0, 8).map((h) => (
            <button
              key={h.id}
              type="button"
              className={`searchbar-recent${h.id === activeId ? ' is-active' : ''}`}
              onClick={() => onPickRecent?.(h.id)}
            >
              <span className="searchbar-recent-q">{h.query}</span>
              <span className="searchbar-recent-meta">
                {fmtDateTime(h.createdAt)} · {STR.historyStats(h.stats?.relevant ?? 0, h.stats?.total ?? 0)}
              </span>
            </button>
          ))}
        </div>
      )}
      {text && (
        <button type="button" className="searchbar-x" onClick={() => onTextChange('')} aria-label={STR.searchClear}>
          ×
        </button>
      )}
      <label className="deep-toggle" title={deep ? STR.deepHint : STR.softHint}>
        <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} />
        <span>{STR.deepToggle}</span>
      </label>
      <button
        type="submit"
        className="btn btn-primary searchbar-go"
        disabled={aiBusy || !text.trim()}
        title={hasKey ? STR.searchAi : STR.aiNoKeyHint}
      >
        <SparkIcon />
        <span className="searchbar-go-label">{aiBusy ? STR.searching : STR.searchAiShort}</span>
        {!hasKey && (
          <span className="ai-lock" aria-hidden="true">
            🔑
          </span>
        )}
      </button>
      {player && (
        <PlayButton
          className="searchbar-play"
          active={player.playing}
          loading={player.loadingId != null}
          disabled={!player.hasItems}
          onClick={player.toggleAll}
          playLabel={STR.playAll}
          stopLabel={STR.stopPlayback}
        />
      )}
    </form>
  );
}
