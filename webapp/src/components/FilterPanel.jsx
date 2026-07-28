import FacetGroup from './FacetGroup.jsx';
import { useStrings } from '../i18n.jsx';

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Conteúdo dos filtros — COMPARTILHADO entre a Sidebar (desktop) e o FilterDrawer (mobile).
 * Fontes (multi-seleção), rodízio de fontes, período (presets 7/30 dias), verificação e as 9 facetas.
 */
export default function FilterPanel({ meta, filters, dispatch, facetCounts, mix, onMixChange }) {
  const STR = useStrings();
  const { FACET_LABEL, VERIFY_LABEL } = STR;
  const set = (key, value) => dispatch({ type: 'set', key, value });
  const preset = (days) => {
    dispatch({ type: 'set', key: 'from', value: daysAgoIso(days) });
    dispatch({ type: 'set', key: 'to', value: '' });
  };
  const selected = filters.sourceIds || [];

  return (
    <div className="filter-panel">
      <fieldset className="filter-block">
        <legend className="facet-label">{STR.filterSource}</legend>
        {/* multi-seleção em UNIÃO: nada marcado = todas (o "Todas as fontes" é o estado vazio) */}
        <div className="source-list">
          {meta.sources.map((s) => (
            <label key={s.id} className="source-item">
              <input
                type="checkbox"
                checked={selected.includes(s.id)}
                onChange={() => dispatch({ type: 'toggleSource', id: s.id })}
              />
              <span className="source-name">{s.name}</span>
              <span className="chip-count">{s.count}</span>
            </label>
          ))}
        </div>
        {selected.length > 0 ? (
          <button type="button" className="chip chip-more" onClick={() => set('sourceIds', [])}>
            {STR.filterAllSources}
          </button>
        ) : (
          <span className="filter-hint">{STR.filterSourcesHint}</span>
        )}
      </fieldset>

      {/* Ordem de exibição: rodízio entre fontes dentro de cada data (ligado) vs agrupado por fonte. */}
      <label className="filter-block switch-row">
        <input type="checkbox" checked={mix} onChange={(e) => onMixChange(e.target.checked)} />
        <span>
          <span className="facet-label">{STR.mixSources}</span>
          <span className="filter-hint">{STR.mixSourcesHint}</span>
        </span>
      </label>

      <fieldset className="filter-block">
        <legend className="facet-label">{STR.filterPeriod}</legend>
        <div className="date-row">
          <label className="date-field">
            <span>{STR.filterFrom}</span>
            <input
              type="date"
              className="input"
              value={filters.from}
              min={meta.dates.min || undefined}
              max={filters.to || meta.dates.max || undefined}
              onChange={(e) => set('from', e.target.value)}
            />
          </label>
          <label className="date-field">
            <span>{STR.filterTo}</span>
            <input
              type="date"
              className="input"
              value={filters.to}
              min={filters.from || meta.dates.min || undefined}
              max={meta.dates.max || undefined}
              onChange={(e) => set('to', e.target.value)}
            />
          </label>
        </div>
        <div className="chip-row">
          <button type="button" className="chip" onClick={() => preset(7)}>
            {STR.last7}
          </button>
          <button type="button" className="chip" onClick={() => preset(30)}>
            {STR.last30}
          </button>
        </div>
      </fieldset>

      <label className="filter-block">
        <span className="facet-label">{STR.filterVerify}</span>
        <select className="input" value={filters.verify} onChange={(e) => set('verify', e.target.value)}>
          <option value="">{STR.verifyAll}</option>
          {Object.entries(VERIFY_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>

      <div className="filter-block">
        <span className="facet-label facet-label-strong">{STR.filterFacets}</span>
        {meta.facets.map((f) => (
          <FacetGroup
            key={f.name}
            name={f.name}
            label={FACET_LABEL[f.name] || f.name}
            tags={f.tags}
            selected={filters.facets[f.name] || []}
            counts={facetCounts?.[f.name]}
            onToggle={(facet, tag) => dispatch({ type: 'toggleTag', facet, tag })}
          />
        ))}
      </div>
    </div>
  );
}
