import { useMemo, useState } from 'react';
import FacetGroup from './FacetGroup.jsx';
import {
  Accordion,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from '@/components/motion-ui/accordion';
import { countActiveFilters } from '../lib/filters.js';
import { useStrings } from '../i18n.jsx';

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

const DEFAULT_OPEN_FACETS = ['domain', 'topic-technology', 'content-type'];

/**
 * Conteúdo dos filtros — COMPARTILHADO entre a Sidebar (desktop) e o FilterDrawer (mobile).
 * Fontes (multi-seleção), período (presets 7/30 dias + todo o histórico), verificação e as 9
 * facetas organizadas em Accordions (Progressive Disclosure) com busca instantânea de tags.
 */
export default function FilterPanel({ meta, filters, dispatch, facetCounts }) {
  const STR = useStrings();
  const { FACET_LABEL, VERIFY_LABEL } = STR;
  const [tagQuery, setTagQuery] = useState('');
  const [openFacets, setOpenFacets] = useState(() => DEFAULT_OPEN_FACETS);

  const set = (key, value) => dispatch({ type: 'set', key, value });
  const preset = (days) => {
    dispatch({ type: 'set', key: 'from', value: daysAgoIso(days) });
    dispatch({ type: 'set', key: 'to', value: '' });
  };
  const selected = filters.sourceIds || [];
  const nActive = countActiveFilters(filters);
  const trimmedTagQuery = tagQuery.trim().toLowerCase();

  // Garante que facetas com tags selecionadas ou que batem com a busca de tag fiquem abertas
  const effectiveOpenFacets = useMemo(() => {
    const setOpen = new Set(openFacets);
    for (const [facet, list] of Object.entries(filters.facets || {})) {
      if (list && list.length > 0) setOpen.add(facet);
    }
    if (trimmedTagQuery && meta?.facets) {
      for (const f of meta.facets) {
        if (f.tags.some((t) => t.tag.toLowerCase().includes(trimmedTagQuery))) {
          setOpen.add(f.name);
        }
      }
    }
    return [...setOpen];
  }, [openFacets, filters.facets, trimmedTagQuery, meta]);

  return (
    <div className="filter-panel">
      {nActive > 0 && (
        <div className="filter-panel-bar">
          <span className="filter-active-summary">
            <strong>{nActive}</strong> {STR.activeFilters}
          </span>
          <button
            type="button"
            className="chip chip-more"
            onClick={() => dispatch({ type: 'clear' })}
          >
            {STR.clearFilters}
          </button>
        </div>
      )}

      <fieldset className="filter-block filter-card-section">
        <legend className="facet-label">{STR.filterSource}</legend>
        <div className="source-list">
          {meta.sources.map((s) => {
            const isChecked = selected.includes(s.id);
            return (
              <label key={s.id} className="source-item" data-checked={isChecked || undefined}>
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => dispatch({ type: 'toggleSource', id: s.id })}
                />
                <span className="source-name">{s.name}</span>
                <span className="chip-count">{s.count}</span>
              </label>
            );
          })}
        </div>
        {selected.length > 0 ? (
          <button type="button" className="chip chip-more" onClick={() => set('sourceIds', [])}>
            {STR.filterAllSources}
          </button>
        ) : (
          <span className="filter-hint">{STR.filterSourcesHint}</span>
        )}
      </fieldset>

      <fieldset className="filter-block filter-card-section">
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
          <button
            type="button"
            className="chip"
            data-on={(!filters.from && !filters.to) || undefined}
            onClick={() => dispatch({ type: 'setPeriod', from: '', to: '' })}
          >
            {STR.heroQuickAllTime}
          </button>
        </div>
      </fieldset>

      <div className="filter-block filter-card-section">
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

        <label className="filter-block switch-row">
          <input
            type="checkbox"
            checked={filters.showJunk === true}
            onChange={(e) => set('showJunk', e.target.checked)}
          />
          <span>
            <span className="facet-label">{STR.showJunk}</span>
            <span className="filter-hint">{STR.showJunkHint}</span>
          </span>
        </label>
      </div>

      <div className="filter-block filter-facets-section">
        <div className="filter-facets-head">
          <span className="facet-label facet-label-strong">{STR.filterFacets}</span>
          <div className="filter-tag-search-wrap">
            <input
              type="search"
              className="input filter-tag-search"
              placeholder={STR.filterTagSearchPlaceholder}
              aria-label={STR.filterTagSearchPlaceholder}
              value={tagQuery}
              onChange={(e) => setTagQuery(e.target.value)}
            />
            {tagQuery && (
              <button
                type="button"
                className="filter-tag-search-clear"
                onClick={() => setTagQuery('')}
                aria-label={STR.searchClear}
              >
                ×
              </button>
            )}
          </div>
        </div>

        <Accordion
          multiple={true}
          value={effectiveOpenFacets}
          onValueChange={setOpenFacets}
        >
          {meta.facets.map((f) => {
            const selectedInFacet = filters.facets[f.name] || [];
            return (
              <AccordionItem key={f.name} value={f.name}>
                <AccordionTrigger badge={selectedInFacet.length}>
                  {FACET_LABEL[f.name] || f.name}
                </AccordionTrigger>
                <AccordionPanel>
                  <FacetGroup
                    name={f.name}
                    label={FACET_LABEL[f.name] || f.name}
                    tags={f.tags}
                    selected={selectedInFacet}
                    counts={facetCounts?.[f.name]}
                    tagFilter={trimmedTagQuery}
                    hideLegend={true}
                    onToggle={(facet, tag) => dispatch({ type: 'toggleTag', facet, tag })}
                  />
                </AccordionPanel>
              </AccordionItem>
            );
          })}
        </Accordion>
      </div>
    </div>
  );
}
