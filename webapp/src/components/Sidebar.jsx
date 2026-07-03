import FilterPanel from './FilterPanel.jsx';
import { STR } from '../strings.js';

/** Filtros persistentes do desktop (≥900px). No mobile o mesmo painel vive no FilterDrawer. */
export default function Sidebar({ meta, filters, dispatch }) {
  return (
    <aside className="sidebar" aria-label={STR.filters}>
      <FilterPanel meta={meta} filters={filters} dispatch={dispatch} />
    </aside>
  );
}
