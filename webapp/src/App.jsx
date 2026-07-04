import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { AnimatePresence, useMotionValueEvent, useScroll } from 'motion/react';
import TopBar from './components/TopBar.jsx';
import CostBadge from './components/CostBadge.jsx';
import KeyButton from './components/KeyButton.jsx';
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
import { useDebouncedValue } from './hooks/useDebouncedValue.js';
import { EMPTY_FILTERS, applyFilters, countActiveFilters, sortForDisplay } from './lib/filters.js';
import { searchText } from './lib/textSearch.js';
import { useStrings } from './i18n.jsx';
import Tutorial from './components/Tutorial.jsx';
import { getTutorialSeen, setTutorialSeen } from './lib/storage.js';
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

export default function App() {
  const STR = useStrings();
  const KIND_OPTIONS = ['all', 'news', 'tool', 'release'].map((v) => ({ value: v, label: STR.KIND_LABEL[v] }));
  // o juiz da busca IA só devolve news|tool — a opção Releases some no modo IA (paridade)
  const KIND_OPTIONS_AI = KIND_OPTIONS.filter((o) => o.value !== 'release');
  const { theme, toggle } = useTheme();
  const { meta, articles, byId, error, loading, retry } = useSnapshot();
  const [filters, dispatch] = useReducer(filtersReducer, { ...EMPTY_FILTERS });
  const [detailId, setDetailId] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [textInput, setTextInput] = useState('');
  const textQuery = useDebouncedValue(textInput, 180);
  const isDesktop = useMediaQuery('(min-width: 900px)');
  const ai = useAiSearch({ articles, meta, filters });

  // Tutorial de introdução: abre sozinho na 1ª visita (flag no localStorage); o botão de ajuda
  // (topbar) reabre sempre. closeTutorial marca como visto e desmonta.
  const [tutorialOpen, setTutorialOpen] = useState(() => !getTutorialSeen());
  const closeTutorial = useCallback(() => {
    setTutorialSeen();
    setTutorialOpen(false);
  }, []);

  // Digitar filtra LOCALMENTE (sem chave). Se havia um resultado de IA na tela, editar o texto
  // volta ao modo local (a IA é re-disparada só pelo botão) — evita confusão de dois modos.
  const onTextChange = (v) => {
    setTextInput(v);
    if (ai.phase === 'done' || ai.phase === 'error') ai.clear();
  };

  // topbar ganha borda ao rolar (sinal via MotionValue; a camada anima só opacity/transform)
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  useMotionValueEvent(scrollY, 'change', (v) => setScrolled(v > 8));

  const toolTypes = meta?.toolContentTypes || [];
  // Browse = filtros estruturados (sidebar) + busca textual LOCAL (o "search sem inteligência").
  const filtered = useMemo(
    () => (articles ? sortForDisplay(searchText(applyFilters(articles, filters, toolTypes), textQuery)) : []),
    [articles, filters, toolTypes, textQuery],
  );

  // modo IA: hits decorados com a ficha do snapshot; Segmented filtra pelo kind do JUIZ.
  // Durante `running` os hits vêm do streaming (partialHits, ao vivo); ao terminar, do result.
  const aiActive = ai.phase === 'done' && ai.result;
  const aiRunning = ai.phase === 'running';
  const aiHits = aiActive ? ai.result.hits : aiRunning ? ai.partialHits : null;
  const aiItems = useMemo(() => {
    if (!aiHits) return null;
    return aiHits
      .map((h) => ({ article: byId.get(h.id), relation: h.relation, judgeKind: h.kind }))
      .filter((x) => x.article);
  }, [aiHits, byId]);
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
    () => JSON.stringify(filters) + `|q:${textQuery}` + (aiActive ? `|ai:${ai.result.query}:${ai.result.hits.length}` : ''),
    [filters, textQuery, aiActive, ai.result],
  );
  const pagedVisible = useVisibleCount(displayItems.length, resetKey);
  // streaming (running): mostra TODOS os hits que já chegaram, sem paginação; no done volta a paginar
  const visible = aiRunning ? displayItems.length : pagedVisible;
  const nActive = countActiveFilters(filters);
  const detail = detailId != null ? byId.get(detailId) : null;

  return (
    <div className="app">
      <TopBar
        theme={theme}
        onToggleTheme={toggle}
        onHelp={() => setTutorialOpen(true)}
        scrolled={scrolled}
        right={
          meta ? (
            <>
              <KeyButton hasKey={ai.hasKey} onClick={ai.openKeyModal} />
              <CostBadge baseUsd={meta.cost.totalUsd} sessionUsd={ai.sessionUsd} />
            </>
          ) : null
        }
      >
        {meta && (
          <SearchBar
            text={textInput}
            onTextChange={onTextChange}
            onAiSearch={(deep) => ai.submit(textInput, deep)}
            aiBusy={ai.phase === 'running'}
            hasKey={ai.hasKey}
          />
        )}
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
                label={STR.kindLabel}
              />
              {articles && (
                <span className="result-count">
                  <AnimatedCount value={displayItems.length} />{' '}
                  {STR.articleWord(displayItems.length)}
                </span>
              )}
            </div>

            {ai.phase === 'running' && (
              <AiProgress progress={ai.progress} deep={ai.deep} startedAt={ai.startedAt} onCancel={ai.cancel} />
            )}
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

            {!aiActive && !aiRunning && meta && <ActivePills filters={filters} meta={meta} dispatch={dispatch} />}

            {loading ? (
              <div className="grid" aria-busy="true">
                {Array.from({ length: 9 }, (_, i) => (
                  <CardSkeleton key={i} />
                ))}
              </div>
            ) : displayItems.length === 0 ? (
              aiRunning ? null : (
                <EmptyState
                  title={
                    aiActive
                      ? STR.emptyFiltered
                      : articles && articles.length === 0
                        ? STR.emptyBase
                        : STR.emptyFiltered
                  }
                />
              )
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
        hasStoredKey={ai.hasKey}
        onSave={ai.saveKey}
        onDismiss={ai.dismissKey}
        onForget={ai.forgetKey}
      />

      <AnimatePresence>{tutorialOpen && <Tutorial onClose={closeTutorial} />}</AnimatePresence>
    </div>
  );
}
