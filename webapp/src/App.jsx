import { useEffect, useMemo, useReducer, useState } from 'react';
import { AnimatePresence, useMotionValueEvent, useScroll } from 'motion/react';
import TopBar from './components/TopBar.jsx';
import CostBadge from './components/CostBadge.jsx';
import SearchBar from './components/SearchBar.jsx';
import Segmented from './components/Segmented.jsx';
import Sidebar from './components/Sidebar.jsx';
import FilterDrawer from './components/FilterDrawer.jsx';
import ActivePills from './components/ActivePills.jsx';
import ArticleGrid from './components/ArticleGrid.jsx';
import CardSkeleton from './components/CardSkeleton.jsx';
import DetailSheet from './components/DetailSheet.jsx';
import AnimatedCount from './components/AnimatedCount.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import KeyModal from './components/KeyModal.jsx';
import AiProgress from './components/AiProgress.jsx';
import AiBanner from './components/AiBanner.jsx';
import { EmptyState, ErrorState } from './components/States.jsx';
import { useTheme } from './hooks/useTheme.js';
import { useSnapshot } from './hooks/useSnapshot.js';
import { useAiSearch } from './hooks/useAiSearch.js';
import { useVisibleCount } from './hooks/useVisibleCount.js';
import { useMediaQuery } from './hooks/useMediaQuery.js';
import { EMPTY_FILTERS, applyFilters, countActiveFilters, sortForDisplay } from './lib/filters.js';
import { KIND_LABEL, STR } from './strings.js';
import './styles/app.css';

function filtersReducer(state, action) {
  switch (action.type) {
    case 'set':
      return { ...state, [action.key]: action.value };
    case 'setPeriod':
      return { ...state, from: action.from, to: action.to };
    case 'toggleTag': {
      const cur = state.facets[action.facet] || [];
      const next = cur.includes(action.tag) ? cur.filter((t) => t !== action.tag) : [...cur, action.tag];
      const facets = { ...state.facets };
      if (next.length) facets[action.facet] = next;
      else delete facets[action.facet];
      return { ...state, facets };
    }
    case 'clear':
      return { ...EMPTY_FILTERS };
    default:
      return state;
  }
}

const KIND_OPTIONS = ['all', 'news', 'tool', 'release'].map((v) => ({ value: v, label: KIND_LABEL[v] }));
// o juiz da busca IA só devolve news|tool — a opção Releases some no modo IA (paridade)
const KIND_OPTIONS_AI = KIND_OPTIONS.filter((o) => o.value !== 'release');

export default function App() {
  const { theme, toggle } = useTheme();
  const { meta, articles, byId, error, loading, retry } = useSnapshot();
  const [filters, dispatch] = useReducer(filtersReducer, { ...EMPTY_FILTERS });
  const [detailId, setDetailId] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 900px)');
  const ai = useAiSearch({ articles, meta, filters });

  // topbar ganha borda ao rolar (sinal via MotionValue; a camada anima só opacity/transform)
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  useMotionValueEvent(scrollY, 'change', (v) => setScrolled(v > 8));

  const toolTypes = meta?.toolContentTypes || [];
  const filtered = useMemo(
    () => (articles ? sortForDisplay(applyFilters(articles, filters, toolTypes)) : []),
    [articles, filters, toolTypes],
  );

  // modo IA: hits decorados com a ficha do snapshot; Segmented filtra pelo kind do JUIZ
  const aiActive = ai.phase === 'done' && ai.result;
  const aiItems = useMemo(() => {
    if (!aiActive) return null;
    return ai.result.hits
      .map((h) => ({ article: byId.get(h.id), relation: h.relation, judgeKind: h.kind }))
      .filter((x) => x.article);
  }, [aiActive, ai.result, byId]);
  const aiShown = useMemo(() => {
    if (!aiItems) return null;
    return filters.kind === 'all' ? aiItems : aiItems.filter((x) => x.judgeKind === filters.kind);
  }, [aiItems, filters.kind]);
  const relationById = useMemo(() => {
    if (!aiShown) return null;
    return new Map(aiShown.map((x) => [x.article.id, x.relation]));
  }, [aiShown]);

  // resultados IA não têm bucket release: se estava selecionado, volta pro Tudo
  useEffect(() => {
    if ((ai.phase === 'running' || aiActive) && filters.kind === 'release') {
      dispatch({ type: 'set', key: 'kind', value: 'all' });
    }
  }, [ai.phase, aiActive, filters.kind]);

  const displayItems = aiShown ? aiShown.map((x) => x.article) : filtered;
  const resetKey = useMemo(
    () => JSON.stringify(filters) + (aiActive ? `|ai:${ai.result.query}:${ai.result.hits.length}` : ''),
    [filters, aiActive, ai.result],
  );
  const visible = useVisibleCount(displayItems.length, resetKey);
  const nActive = countActiveFilters(filters);
  const detail = detailId != null ? byId.get(detailId) : null;

  return (
    <div className="app">
      <TopBar
        theme={theme}
        onToggleTheme={toggle}
        scrolled={scrolled}
        right={meta ? <CostBadge baseUsd={meta.cost.totalUsd} sessionUsd={ai.sessionUsd} /> : null}
      >
        {meta && <SearchBar onSubmit={ai.submit} busy={ai.phase === 'running'} />}
      </TopBar>

      {error ? (
        <main className="layout layout-center">
          <ErrorState message={STR.loadError} onRetry={retry} />
        </main>
      ) : (
        <main className="layout" data-desktop={isDesktop || undefined}>
          {isDesktop && meta && <Sidebar meta={meta} filters={filters} dispatch={dispatch} />}
          <section className="content">
            <div className="content-head">
              <Segmented
                value={filters.kind}
                options={aiActive || ai.phase === 'running' ? KIND_OPTIONS_AI : KIND_OPTIONS}
                onChange={(v) => dispatch({ type: 'set', key: 'kind', value: v })}
                label="Tipo de item"
              />
              {articles && (
                <span className="result-count">
                  <AnimatedCount value={displayItems.length} />{' '}
                  {displayItems.length === 1 ? 'artigo' : 'artigos'}
                </span>
              )}
            </div>

            {ai.phase === 'running' && <AiProgress progress={ai.progress} deep={ai.deep} onCancel={ai.cancel} />}
            {aiActive && <AiBanner result={ai.result} onClear={ai.clear} />}
            {ai.phase === 'error' && (
              <div className="ai-error" role="alert">
                <span>{ai.error}</span>
                <span className="ai-error-actions">
                  {ai.query && (
                    <button type="button" className="btn" onClick={() => ai.submit(ai.query, ai.deep)}>
                      {STR.aiRetry}
                    </button>
                  )}
                  <button type="button" className="btn" onClick={ai.clear}>
                    {STR.aiClear}
                  </button>
                </span>
              </div>
            )}

            {!aiActive && meta && <ActivePills filters={filters} meta={meta} dispatch={dispatch} />}

            {loading ? (
              <div className="grid" aria-busy="true">
                {Array.from({ length: 9 }, (_, i) => (
                  <CardSkeleton key={i} />
                ))}
              </div>
            ) : displayItems.length === 0 ? (
              <EmptyState
                title={
                  aiActive
                    ? STR.emptyFiltered
                    : articles && articles.length === 0
                      ? STR.emptyBase
                      : STR.emptyFiltered
                }
              />
            ) : (
              <ArticleGrid
                items={displayItems}
                toolTypes={toolTypes}
                onOpen={setDetailId}
                visible={visible}
                relationById={relationById}
              />
            )}
          </section>
        </main>
      )}

      {!isDesktop && meta && !error && (
        <>
          <button type="button" className="fab" onClick={() => setDrawerOpen(true)}>
            {STR.filters}
            {nActive > 0 && <span className="fab-badge">{nActive}</span>}
          </button>
          <FilterDrawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            meta={meta}
            filters={filters}
            dispatch={dispatch}
          />
        </>
      )}

      <AnimatePresence>
        {detail && (
          <DetailSheet
            key={detail.id}
            article={detail}
            toolTypes={toolTypes}
            isMobile={!isDesktop}
            onClose={() => setDetailId(null)}
          />
        )}
      </AnimatePresence>

      <ConfirmDialog info={ai.confirmInfo} onConfirm={ai.confirm} onCancel={ai.cancelConfirm} />
      <KeyModal
        modal={ai.keyModal}
        hasStoredKey={ai.hasStoredKey}
        onSave={ai.saveKey}
        onDismiss={ai.dismissKey}
        onForget={ai.forgetKey}
      />
    </div>
  );
}
