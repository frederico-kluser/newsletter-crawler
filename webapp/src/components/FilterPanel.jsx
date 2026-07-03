import FacetGroup from './FacetGroup.jsx';
import { FACET_LABEL, STR, VERIFY_LABEL } from '../strings.js';

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Conteúdo dos filtros — COMPARTILHADO entre a Sidebar (desktop) e o FilterDrawer (mobile).
 * Fonte, período (com presets 7/30 dias), verificação e as 9 facetas.
 */
export default function FilterPanel({ meta, filters, dispatch }) {
  const set = (key, value) => dispatch({ type: 'set', key, value });
  const preset = (days) => {
    dispatch({ type: 'set', key: 'from', value: daysAgoIso(days) });
    dispatch({ type: 'set', key: 'to', value: '' });
  };

  return (
    <div className="filter-panel">
      <label className="filter-block">
        <span className="facet-label">{STR.filterSource}</span>
        <select
          className="input"
          value={filters.sourceId ?? ''}
          onChange={(e) => set('sourceId', e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">{STR.filterAllSources}</option>
          {meta.sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.count})
            </option>
          ))}
        </select>
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
            onToggle={(facet, tag) => dispatch({ type: 'toggleTag', facet, tag })}
          />
        ))}
      </div>
    </div>
  );
}
