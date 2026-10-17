import FilterPanel from './FilterPanel.jsx';
import { Sheet } from '@/components/motion-ui/sheet';
import { countActiveFilters } from '../lib/filters.js';
import { useStrings } from '../i18n.jsx';

/**
 * Drawer inferior de filtros (mobile <900px) sobre o primitivo Sheet do Motion+ UI:
 * entra com spring `gentle`, scrim acoplado ao deslocamento Y e drag-to-dismiss controlado
 * pela alça superior (sem bloquear o scroll interno das facetas).
 */
export default function FilterDrawer({
  open,
  onClose,
  meta,
  filters,
  dispatch,
  facetCounts,
  resultCount,
}) {
  const STR = useStrings();
  const nActive = countActiveFilters(filters);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      ariaLabel={STR.filters}
      isMobile={true}
      overlayClassName="overlay"
      panelClassName="drawer"
      headClassName="drawer-head"
      header={
        <div className="drawer-head-row">
          <div className="drawer-title-group">
            <span className="drawer-title">{STR.filters}</span>
            {nActive > 0 && <span className="filter-btn-badge drawer-badge-inline">{nActive}</span>}
          </div>
          <div className="drawer-head-actions">
            {nActive > 0 && (
              <button
                type="button"
                className="chip chip-more"
                onClick={() => dispatch({ type: 'clear' })}
              >
                {STR.clearFilters}
              </button>
            )}
            <button type="button" className="icon-btn" onClick={onClose} aria-label={STR.close}>
              ✕
            </button>
          </div>
        </div>
      }
      footer={
        <div className="drawer-footer">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {resultCount != null ? STR.applyAndSee(resultCount) : STR.close}
          </button>
        </div>
      }
    >
      <div className="drawer-body">
        <FilterPanel
          meta={meta}
          filters={filters}
          dispatch={dispatch}
          facetCounts={facetCounts}
        />
      </div>
    </Sheet>
  );
}
