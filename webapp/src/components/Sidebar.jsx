import FilterPanel from './FilterPanel.jsx';
import { useStrings } from '../i18n.jsx';

/** Filtros persistentes do desktop (≥900px). No mobile o mesmo painel vive no FilterDrawer. */
export default function Sidebar({ meta, filters, dispatch, facetCounts }) {
  const STR = useStrings();
  return (
    <aside className="sidebar" aria-label={STR.filters}>
      <FilterPanel meta={meta} filters={filters} dispatch={dispatch} facetCounts={facetCounts} />
    </aside>
  );
}
