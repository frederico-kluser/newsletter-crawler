import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AnimatePresence, motion, useMotionValueEvent, useScroll } from 'motion/react';
import { CommandPalette } from '@/components/motion-ui/command-palette';
import { useMotionUITransition } from '@/components/motion-ui/ui-theme';
import TopBar from './components/TopBar.jsx';
import EditorialHero from './components/EditorialHero.jsx';
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
import HistoryPanel from './components/HistoryPanel.jsx';
import AiProgress from './components/AiProgress.jsx';
import AiBanner from './components/AiBanner.jsx';
import { EmptyState, ErrorState } from './components/States.jsx';
import { useTheme } from './hooks/useTheme.js';
import { useSnapshot } from './hooks/useSnapshot.js';
import { useAiSearch } from './hooks/useAiSearch.js';
import { useVisibleCount } from './hooks/useVisibleCount.js';
import { useMediaQuery } from './hooks/useMediaQuery.js';
import { useDebouncedValue } from './hooks/useDebouncedValue.js';
import {
  EMPTY_FILTERS,
  applyFilters,
  computeFacetCounts,
  countActiveFilters,
  normalizeScope,
  sortForDisplay,
} from './lib/filters.js';
import { loadViewState, saveViewState } from './lib/viewState.js';
import { searchText } from './lib/textSearch.js';
import { useLocale, useStrings } from './i18n.jsx';
import Tutorial from './components/Tutorial.jsx';
import { PlayerProvider } from './player.jsx';
import { getTutorialSeen, setTutorialSeen } from './lib/storage.js';
import './styles/app.css';

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function findTopVisibleArticleId() {
  if (typeof document === 'undefined') return null;
  const cards = document.querySelectorAll('.card[data-article-id]');
  for (const el of cards) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom > 88) {
      const id = Number(el.getAttribute('data-article-id'));
      return Number.isInteger(id) && id > 0 ? id : null;
    }
  }
  return null;
}

function filtersReducer(state, action) {
  switch (action.type) {
    case 'set':
      return { ...state, [action.key]: action.value };
    case 'setPeriod':
      return { ...state, from: action.from, to: action.to };
    case 'toggleSource': {
      const cur = state.sourceIds || [];
      return {
        ...state,
        sourceIds: cur.includes(action.id) ? cur.filter((i) => i !== action.id) : [...cur, action.id],
      };
    }
    case 'toggleTag': {
      const cur = state.facets[action.facet] || [];
      const next = cur.includes(action.tag) ? cur.filter((t) => t !== action.tag) : [...cur, action.tag];
      const facets = { ...state.facets };
      if (next.length) facets[action.facet] = next;
      else delete facets[action.facet];
      return { ...state, facets };
    }
    case 'clear':
      return { ...EMPTY_FILTERS, facets: {} };
    default:
      return state;
  }
}

export default function App() {
  const STR = useStrings();
  const { toggle: toggleLocale } = useLocale();
  const snapTransition = useMotionUITransition('snap');

  // Carrega o estado salvo (filtros, busca local, paginação e scroll) UMA vez no boot
  const initialViewRef = useRef(null);
  if (!initialViewRef.current) {
    initialViewRef.current = loadViewState();
  }
  const initView = initialViewRef.current;

  const KIND_OPTIONS = ['all', 'news', 'tool', 'release'].map((v) => ({
    value: v,
    label: STR.KIND_LABEL[v],
  }));
  const KIND_OPTIONS_AI = KIND_OPTIONS.filter((o) => o.value !== 'release');

  const { theme, toggle: toggleTheme } = useTheme();
  const { meta, articles, byId, error, loading, retry } = useSnapshot();
  const [filters, dispatchRaw] = useReducer(filtersReducer, initView.filters);
  const [detailId, setDetailId] = useState(null);
  const [strict, setStrict] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [textInput, setTextInput] = useState(initView.textInput);
  const textQuery = useDebouncedValue(textInput, 180);
  const isDesktop = useMediaQuery('(min-width: 900px)');
  const ai = useAiSearch({ articles, meta, filters });

  // Controle de restauração do scroll: evita sobrescrever o scroll salvo com 0 enquanto o
  // snapshot ainda está carregando, e restaura assim que os cards entram no DOM.
  const scrollPosRef = useRef({
    scrollY: initView.scrollY,
    anchorId: initView.anchorId,
  });
  const scrollRestoredRef = useRef(!initView.restored || initView.scrollY <= 0);
  const [restoredNotice, setRestoredNotice] = useState(
    () => initView.restored && initView.scrollY > 240,
  );

  // Ao alterar qualquer filtro manualmente, voltamos ao topo da lista e limpamos o scroll salvo
  const dispatch = useCallback((action) => {
    dispatchRaw(action);
    scrollPosRef.current = { scrollY: 0, anchorId: null };
    scrollRestoredRef.current = true;
    setRestoredNotice(false);
    if (typeof window !== 'undefined' && window.scrollY > 240) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);

  const [tutorialOpen, setTutorialOpen] = useState(() => !getTutorialSeen());
  const closeTutorial = useCallback(() => {
    setTutorialSeen();
    setTutorialOpen(false);
  }, []);

  const onTextChange = useCallback(
    (v) => {
      setTextInput(v);
      scrollPosRef.current = { scrollY: 0, anchorId: null };
      scrollRestoredRef.current = true;
      setRestoredNotice(false);
      if (ai.phase === 'done' || ai.phase === 'error' || ai.phase === 'paused') ai.clear();
    },
    [ai],
  );

  const restoreScope = useCallback((scope) => {
    if (!scope) return;
    const s = normalizeScope(scope);
    dispatchRaw({ type: 'set', key: 'sourceIds', value: s.sourceIds });
    dispatchRaw({ type: 'setPeriod', from: s.from, to: s.to });
  }, []);

  useEffect(() => {
    if (!ai.resumeInfo) return;
    setTextInput(ai.resumeInfo.query);
    restoreScope(ai.resumeInfo.scope);
  }, [ai.resumeInfo, restoreScope]);

  const openFromHistory = (id) => {
    setHistoryOpen(false);
    const entry = ai.restore(id);
    if (entry) {
      setTextInput(entry.query);
      restoreScope(entry.scope);
    }
  };
  const rerunFromHistory = (id) => {
    setHistoryOpen(false);
    const entry = ai.rerun(id);
    if (entry) {
      setTextInput(entry.query);
      restoreScope(entry.scope);
    }
  };

  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  const [scrolledFar, setScrolledFar] = useState(false);
  useMotionValueEvent(scrollY, 'change', (v) => {
    setScrolled(v > 8);
    setScrolledFar(v > 420);
  });

  const toolTypes = meta?.toolContentTypes || [];
  const sourceName = useCallback(
    (id) => meta?.sources.find((s) => s.id === id)?.name || '',
    [meta],
  );
  const sortOpts = useMemo(() => ({ mix: true, sourceName }), [sourceName]);

  const filtered = useMemo(
    () =>
      articles
        ? sortForDisplay(searchText(applyFilters(articles, filters, toolTypes), textQuery), sortOpts)
        : [],
    [articles, filters, toolTypes, textQuery, sortOpts],
  );

  const facetCounts = useMemo(
    () => (articles ? computeFacetCounts(filtered) : null),
    [articles, filtered],
  );

  const aiActive = ai.phase === 'done' && ai.result;
  const aiRunning = ai.phase === 'running';
  const aiPaused = ai.phase === 'paused';
  const aiLive = aiRunning || aiPaused;
  const aiHits = aiActive ? ai.result.hits : aiLive ? ai.partialHits : null;
  const aiItems = useMemo(() => {
    if (!aiHits) return null;
    return aiHits
      .map((h) => ({ article: byId.get(h.id), relation: h.relation, judgeKind: h.kind }))
      .filter((x) => x.article);
  }, [aiHits, byId]);

  const aiShown = useMemo(() => {
    if (!aiItems) return null;
    return aiItems.filter(
      (x) =>
        (filters.kind === 'all' || x.judgeKind === filters.kind) &&
        (!strict || x.relation === 'direct'),
    );
  }, [aiItems, filters.kind, strict]);

  const hiddenSimilar = useMemo(() => {
    if (!aiItems || !strict) return 0;
    return aiItems.filter(
      (x) => (filters.kind === 'all' || x.judgeKind === filters.kind) && x.relation !== 'direct',
    ).length;
  }, [aiItems, filters.kind, strict]);

  const relationById = useMemo(() => {
    if (!aiShown) return null;
    return new Map(aiShown.map((x) => [x.article.id, x.relation]));
  }, [aiShown]);

  const aiMissing =
    aiActive && ai.result.frozen ? ai.result.hits.length - (aiItems?.length ?? 0) : 0;

  useEffect(() => {
    if ((aiLive || aiActive) && filters.kind === 'release') {
      dispatchRaw({ type: 'set', key: 'kind', value: 'all' });
    }
  }, [aiLive, aiActive, filters.kind]);

  const aiOrdered = useMemo(() => {
    if (!aiShown) return null;
    const list = aiShown.map((x) => x.article);
    return aiActive ? sortForDisplay(list, sortOpts) : list;
  }, [aiShown, aiActive, sortOpts]);

  const displayItems = aiOrdered ?? filtered;

  const playerItems = useMemo(
    () =>
      displayItems.map((a) => ({
        id: a.id,
        title: a.title_pt || a.title || a.url,
        text: a.summary_pt || a.snippet || '',
      })),
    [displayItems],
  );

  const resetKey = useMemo(
    () =>
      JSON.stringify(filters) +
      `|q:${textQuery}` +
      (aiActive ? `|ai:${ai.result.query}:${ai.result.hits.length}` : ''),
    [filters, textQuery, aiActive, ai.result],
  );

  const pagedVisible = useVisibleCount(
    displayItems.length,
    resetKey,
    24,
    initView.visibleCount,
  );
  const visible = aiLive || aiActive ? displayItems.length : pagedVisible;
  const nActive = countActiveFilters(filters);
  const detail = detailId != null ? byId.get(detailId) : null;

  // 1. Restaura a posição do scroll assim que os artigos são renderizados na 1ª carga
  useEffect(() => {
    if (loading || !articles || scrollRestoredRef.current) return undefined;
    scrollRestoredRef.current = true;
    const targetY = scrollPosRef.current.scrollY;
    const targetAnchor = scrollPosRef.current.anchorId;
    if (targetY <= 0 && !targetAnchor) return undefined;

    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      window.scrollTo({ top: targetY, left: 0, behavior: 'instant' });
      raf2 = requestAnimationFrame(() => {
        if (Math.abs(window.scrollY - targetY) > 140 && targetAnchor != null) {
          const el = document.querySelector(`.card[data-article-id="${targetAnchor}"]`);
          if (el) el.scrollIntoView({ block: 'start', behavior: 'instant' });
        }
      });
    });
    const timer = setTimeout(() => setRestoredNotice(false), 4500);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(timer);
    };
  }, [loading, articles]);

  // 2. Persiste imediatamente mudanças de filtros, texto ou paginação
  useEffect(() => {
    saveViewState({
      filters,
      textInput,
      visibleCount: pagedVisible.rawCount,
      scrollY: scrollPosRef.current.scrollY,
      anchorId: scrollPosRef.current.anchorId,
    });
  }, [filters, textInput, pagedVisible.rawCount]);

  // 3. Persiste o scroll (throttled + em pagehide/visibilitychange) depois que o boot restaurou
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let timer = null;

    const flushScroll = () => {
      if (!scrollRestoredRef.current) return;
      const y = Math.max(0, Math.round(window.scrollY || 0));
      const anchorId = y > 120 ? findTopVisibleArticleId() : null;
      scrollPosRef.current = { scrollY: y, anchorId };
      saveViewState({
        filters,
        textInput,
        visibleCount: pagedVisible.rawCount,
        scrollY: y,
        anchorId,
      });
    };

    const onScroll = () => {
      if (!scrollRestoredRef.current) return;
      if (timer != null) return;
      timer = setTimeout(() => {
        timer = null;
        flushScroll();
      }, 180);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushScroll();
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', flushScroll);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer != null) clearTimeout(timer);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', flushScroll);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [filters, textInput, pagedVisible.rawCount]);

  // Itens da Command Palette (⌘K)
  const commandItems = useMemo(() => {
    const list = [
      {
        id: 'act:clear',
        group: STR.cmdkGroupActions,
        label: STR.clearFilters,
        hint: nActive > 0 ? `${nActive} ${STR.activeFilters}` : undefined,
        badge: '↺',
        keywords: ['reset', 'limpar', 'clear', 'filtros', 'filters'],
        run: () => {
          dispatch({ type: 'clear' });
          onTextChange('');
        },
      },
      {
        id: 'act:theme',
        group: STR.cmdkGroupActions,
        label: theme === 'dark' ? STR.themeToLight : STR.themeToDark,
        badge: theme === 'dark' ? '☀' : '☾',
        shortcut: ['T'],
        keywords: ['theme', 'tema', 'dark', 'light', 'escuro', 'claro'],
        run: toggleTheme,
      },
      {
        id: 'act:locale',
        group: STR.cmdkGroupActions,
        label: `${STR.langLabel}: Português / English`,
        badge: '🌐',
        shortcut: ['L'],
        keywords: ['language', 'idioma', 'pt', 'en', 'english', 'portugues'],
        run: toggleLocale,
      },
      {
        id: 'act:history',
        group: STR.cmdkGroupActions,
        label: STR.historyOpen,
        badge: '🕘',
        shortcut: ['H'],
        keywords: ['history', 'historico', 'buscas', 'searches'],
        run: () => setHistoryOpen(true),
      },
      {
        id: 'act:keys',
        group: STR.cmdkGroupActions,
        label: STR.keyTitleAll,
        badge: '🔑',
        shortcut: ['K'],
        keywords: ['key', 'chave', 'openrouter', 'deepseek', 'byok', 'api'],
        run: ai.openKeyModal,
      },
      {
        id: 'act:tutorial',
        group: STR.cmdkGroupActions,
        label: STR.helpTitle,
        badge: '?',
        keywords: ['help', 'ajuda', 'tutorial', 'tour'],
        run: () => setTutorialOpen(true),
      },
    ];

    for (const k of ['all', 'news', 'tool', 'release']) {
      list.push({
        id: `kind:${k}`,
        group: STR.cmdkGroupKinds,
        label: `${STR.kindLabel}: ${STR.KIND_LABEL[k]}`,
        badge: filters.kind === k ? '✓' : '·',
        active: filters.kind === k,
        keywords: ['kind', 'tipo', k, STR.KIND_LABEL[k]],
        run: () => dispatch({ type: 'set', key: 'kind', value: k }),
      });
    }

    list.push(
      {
        id: 'period:7d',
        group: STR.cmdkGroupPeriod,
        label: `${STR.filterPeriod}: ${STR.last7}`,
        badge: '7d',
        keywords: ['7', 'days', 'dias', 'period', 'periodo', 'semana'],
        run: () => dispatch({ type: 'setPeriod', from: daysAgoIso(7), to: '' }),
      },
      {
        id: 'period:30d',
        group: STR.cmdkGroupPeriod,
        label: `${STR.filterPeriod}: ${STR.last30}`,
        badge: '30d',
        keywords: ['30', 'days', 'dias', 'period', 'periodo', 'mes'],
        run: () => dispatch({ type: 'setPeriod', from: daysAgoIso(30), to: '' }),
      },
      {
        id: 'period:all',
        group: STR.cmdkGroupPeriod,
        label: `${STR.filterPeriod}: ${STR.heroQuickAllTime}`,
        badge: '∞',
        keywords: ['all', 'tudo', 'sempre', 'historico', 'period'],
        run: () => dispatch({ type: 'setPeriod', from: '', to: '' }),
      },
    );

    if (meta?.sources) {
      for (const s of meta.sources) {
        const isSel = (filters.sourceIds || []).includes(s.id);
        list.push({
          id: `source:${s.id}`,
          group: STR.cmdkGroupSources,
          label: s.name,
          hint: STR.filterSource,
          badge: isSel ? '✓' : '○',
          active: isSel,
          count: s.count,
          keywords: ['source', 'fonte', s.name],
          run: () => dispatch({ type: 'toggleSource', id: s.id }),
        });
      }
    }

    if (meta?.facets) {
      for (const f of meta.facets) {
        const facetLabel = STR.FACET_LABEL[f.name] || f.name;
        for (const t of f.tags.slice(0, 6)) {
          const isSel = (filters.facets[f.name] || []).includes(t.tag);
          list.push({
            id: `tag:${f.name}:${t.tag}`,
            group: STR.cmdkGroupTags,
            label: `#${t.tag}`,
            hint: facetLabel,
            badge: isSel ? '✓' : '#',
            active: isSel,
            count: facetCounts?.[f.name]?.[t.tag] ?? t.count,
            keywords: ['tag', f.name, facetLabel, t.tag],
            run: () => dispatch({ type: 'toggleTag', facet: f.name, tag: t.tag }),
          });
        }
      }
    }

    return list;
  }, [STR, nActive, theme, toggleTheme, toggleLocale, ai.openKeyModal, filters, meta, facetCounts, dispatch, onTextChange]);

  const scrollToTop = () => {
    scrollPosRef.current = { scrollY: 0, anchorId: null };
    setRestoredNotice(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <PlayerProvider items={playerItems} audio={meta?.audio} onNeedKey={ai.openKeyModal}>
      <div className="app">
        <TopBar
          theme={theme}
          onToggleTheme={toggleTheme}
          onHelp={() => setTutorialOpen(true)}
          onOpenCommandPalette={() => setCmdkOpen(true)}
          scrolled={scrolled}
          right={
            meta ? (
              <>
                {!isDesktop && !error && (
                  <button
                    type="button"
                    className="icon-btn filter-btn"
                    onClick={() => setDrawerOpen(true)}
                    title={STR.filters}
                    aria-label={STR.filters}
                  >
                    <svg
                      width="17"
                      height="17"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      aria-hidden="true"
                    >
                      <path
                        d="M2.2 3h11.6l-4.4 5.2v4.1l-2.8 1.4V8.2L2.2 3Z"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    </svg>
                    {nActive > 0 && <span className="filter-btn-badge">{nActive}</span>}
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setHistoryOpen(true)}
                  title={STR.historyOpen}
                  aria-label={STR.historyOpen}
                >
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    aria-hidden="true"
                  >
                    <path
                      d="M2.6 8a5.4 5.4 0 105.4-5.4c-1.9 0-3.6 1-4.5 2.5"
                      strokeLinecap="round"
                    />
                    <path d="M3.2 1.8v3.4h3.4" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M8 5.4V8l2 1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <KeyButton hasKey={ai.hasKey} onClick={ai.openKeyModal} />
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
              recents={ai.history}
              onPickRecent={openFromHistory}
              activeId={ai.result?.id}
            />
          )}
        </TopBar>

        {error ? (
          <main className="layout layout-center">
            <ErrorState message={STR.loadError} onRetry={retry} />
          </main>
        ) : (
          <main className="layout" data-desktop={isDesktop || undefined}>
            {isDesktop && meta && (
              <Sidebar
                meta={meta}
                filters={filters}
                dispatch={dispatch}
                facetCounts={facetCounts}
              />
            )}
            <section className="content">
              {meta && (
                <EditorialHero
                  meta={meta}
                  totalArticles={meta.totals?.articles ?? articles?.length ?? 0}
                  filteredCount={displayItems.length}
                  filters={filters}
                  dispatch={dispatch}
                  onOpenCommandPalette={() => setCmdkOpen(true)}
                />
              )}

              <div className="content-head">
                <Segmented
                  value={filters.kind}
                  options={aiActive || aiLive ? KIND_OPTIONS_AI : KIND_OPTIONS}
                  onChange={(v) => dispatch({ type: 'set', key: 'kind', value: v })}
                  label={STR.kindLabel}
                />
                <div className="content-head-right">
                  {articles && (
                    <span className="result-count">
                      <AnimatedCount value={displayItems.length} />{' '}
                      {STR.articleWord(displayItems.length)}
                    </span>
                  )}
                  {(aiActive || aiLive) && (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={strict}
                      className="strict-switch"
                      data-on={strict || undefined}
                      onClick={() => setStrict((v) => !v)}
                      title={STR.strictHint}
                    >
                      <span className="strict-switch-label">{STR.strictToggle}</span>
                      <span className="strict-switch-track" aria-hidden="true">
                        <span className="strict-switch-thumb" />
                      </span>
                    </button>
                  )}
                </div>
              </div>

              {ai.spec && (ai.spec.must_have?.length || ai.spec.query_en) && (
                <div className="spec-banner" aria-live="polite">
                  <span className="spec-label">{STR.specLabel}:</span>
                  {(ai.spec.must_have || []).map((m, i) => (
                    <span key={i} className="spec-chip">
                      {m}
                    </span>
                  ))}
                  {ai.spec.query_en && <span className="spec-en">EN: {ai.spec.query_en}</span>}
                  {hiddenSimilar > 0 && (
                    <span className="spec-hidden">{STR.specHidden(hiddenSimilar)}</span>
                  )}
                </div>
              )}

              {ai.phase === 'running' && (
                <AiProgress
                  progress={ai.progress}
                  deep={ai.deep}
                  startedAt={ai.startedAt}
                  resuming={ai.resuming}
                  baseDone={ai.baseDone}
                  onCancel={ai.cancel}
                />
              )}
              {aiPaused && (
                <div className="ai-error" role="status">
                  <span>{STR.aiPaused}</span>
                  <span className="ai-error-actions">
                    <button type="button" className="btn" onClick={ai.resumeManual}>
                      {STR.aiResumeAction}
                    </button>
                    <button type="button" className="btn" onClick={ai.discardResume}>
                      {STR.aiResumeDiscard}
                    </button>
                  </span>
                </div>
              )}
              {aiActive && (
                <AiBanner
                  result={ai.result}
                  missing={aiMissing}
                  onClear={ai.clear}
                  onRerun={() => ai.submit(ai.result.query, ai.result.deep)}
                />
              )}
              {ai.phase === 'error' && (
                <div className="ai-error" role="alert">
                  <span>{ai.error}</span>
                  <span className="ai-error-actions">
                    {ai.query && (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => ai.submit(ai.query, ai.deep)}
                      >
                        {STR.aiRetry}
                      </button>
                    )}
                    <button type="button" className="btn" onClick={ai.clear}>
                      {STR.aiClear}
                    </button>
                  </span>
                </div>
              )}

              {!aiActive && !aiLive && meta && (
                <ActivePills filters={filters} meta={meta} dispatch={dispatch} />
              )}

              {loading ? (
                <div className="grid" aria-busy="true">
                  {Array.from({ length: 9 }, (_, i) => (
                    <CardSkeleton key={i} />
                  ))}
                </div>
              ) : displayItems.length === 0 ? (
                aiLive ? null : (
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
          <FilterDrawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            meta={meta}
            filters={filters}
            dispatch={dispatch}
            facetCounts={facetCounts}
            resultCount={displayItems.length}
          />
        )}

        {meta && (
          <DetailSheet
            article={detail}
            toolTypes={toolTypes}
            isMobile={!isDesktop}
            onClose={() => setDetailId(null)}
            onToggleTag={(facet, tag) => dispatch({ type: 'toggleTag', facet, tag })}
          />
        )}

        <CommandPalette
          open={cmdkOpen}
          onOpenChange={setCmdkOpen}
          items={commandItems}
          groupOrder={[
            STR.cmdkGroupActions,
            STR.cmdkGroupKinds,
            STR.cmdkGroupPeriod,
            STR.cmdkGroupSources,
            STR.cmdkGroupTags,
            STR.cmdkGroupQuery,
          ]}
          customQueryGroup={STR.cmdkGroupQuery}
          inputPlaceholder={STR.cmdkPlaceholder}
          inputAriaLabel={STR.cmdkPlaceholder}
          dialogLabel={STR.cmdkAria}
          footerHints={[
            { keys: '↑↓', label: STR.cmdkNav },
            { keys: '↵', label: STR.cmdkSelect },
            { keys: 'esc', label: STR.cmdkClose },
          ]}
          renderEmpty={STR.cmdkEmpty}
          customActionLabel={STR.cmdkCustomText}
          onCustomQuerySubmit={(q) => onTextChange(q)}
          onSelect={(item) => item.run?.()}
        />

        <ConfirmDialog info={ai.confirmInfo} onConfirm={ai.confirm} onCancel={ai.cancelConfirm} />
        <KeyModal
          modal={ai.keyModal}
          hasStoredKey={ai.hasKey}
          onSave={ai.saveKey}
          onDismiss={ai.dismissKey}
          onForget={ai.forgetKey}
          onSelect={ai.selectProvider}
        />
        <HistoryPanel
          open={historyOpen}
          items={ai.history}
          activeId={ai.result?.id}
          onClose={() => setHistoryOpen(false)}
          onOpen={openFromHistory}
          onRerun={rerunFromHistory}
          onDelete={ai.removeEntry}
          onClear={ai.clearAll}
        />

        <AnimatePresence>{tutorialOpen && <Tutorial onClose={closeTutorial} />}</AnimatePresence>

        <AnimatePresence>
          {(scrolledFar || restoredNotice) && (
            <motion.div
              className="floating-scroll-dock"
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.95 }}
              transition={{ ...snapTransition }}
            >
              {restoredNotice && (
                <span className="restored-pill" role="status">
                  <span className="restored-dot" aria-hidden="true" />
                  {STR.scrollRestored}
                </span>
              )}
              {scrolledFar && (
                <button
                  type="button"
                  className="back-to-top-btn"
                  onClick={scrollToTop}
                  aria-label={STR.backToTop}
                  title={STR.backToTop}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                    <path d="m18 15-6-6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>{STR.backToTop}</span>
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </PlayerProvider>
  );
}
