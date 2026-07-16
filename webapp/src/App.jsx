import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { AnimatePresence, useMotionValueEvent, useScroll } from 'motion/react';
import TopBar from './components/TopBar.jsx';
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
import { EMPTY_FILTERS, applyFilters, computeFacetCounts, countActiveFilters, sortForDisplay } from './lib/filters.js';
import { searchText } from './lib/textSearch.js';
import { useStrings } from './i18n.jsx';
import Tutorial from './components/Tutorial.jsx';
import { PlayerProvider } from './player.jsx';
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
  const [strict, setStrict] = useState(false); // AMPLO por padrão: mostra 'direct' + 'similar' (Estrito é opt-in)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
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
    if (ai.phase === 'done' || ai.phase === 'error' || ai.phase === 'paused') ai.clear();
  };

  // Restaura o ESCOPO salvo (fonte/período) nos filtros — pills/sidebar refletem a busca reaberta.
  const restoreScope = (scope) => {
    if (!scope) return;
    dispatch({ type: 'set', key: 'sourceId', value: scope.sourceId ?? null });
    dispatch({ type: 'setPeriod', from: scope.from || '', to: scope.to || '' });
  };

  // Retomada de busca (reload/reabrir a aba): o hook decidiu retomar e expôs {query, scope} —
  // sincroniza o campo de texto e os pills com o escopo DO CHECKPOINT (não os filtros da tela).
  useEffect(() => {
    if (!ai.resumeInfo) return;
    setTextInput(ai.resumeInfo.query);
    restoreScope(ai.resumeInfo.scope);
  }, [ai.resumeInfo]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // Contagens de co-ocorrência das tags sobre o conjunto JÁ filtrado: cada chip mostra quantos
  // itens do resultado atual também têm aquela tag, e a UI desabilita as zeradas. null enquanto o
  // acervo não chega (o painel cai no total estático, sem desabilitar nada).
  const facetCounts = useMemo(() => (articles ? computeFacetCounts(filtered) : null), [articles, filtered]);

  // modo IA: hits decorados com a ficha do snapshot; Segmented filtra pelo kind do JUIZ.
  // Durante `running` os hits vêm do streaming (partialHits, ao vivo); ao terminar, do result.
  const aiActive = ai.phase === 'done' && ai.result;
  const aiRunning = ai.phase === 'running';
  const aiPaused = ai.phase === 'paused'; // retomada manual: mostra os parciais + banner Retomar/Descartar
  const aiLive = aiRunning || aiPaused; // fases que exibem hits parciais e travam a paginação
  const aiHits = aiActive ? ai.result.hits : aiLive ? ai.partialHits : null;
  const aiItems = useMemo(() => {
    if (!aiHits) return null;
    return aiHits
      .map((h) => ({ article: byId.get(h.id), relation: h.relation, judgeKind: h.kind }))
      .filter((x) => x.article);
  }, [aiHits, byId]);
  // AMPLO (default): 'direct' + 'similar'; ESTRITO (opt-in): só 'direct' (resposta central).
  // Re-filtra o MESMO scan (zero LLM) — o Estrito é um toggle p/ apertar a precisão quando quiser.
  const aiShown = useMemo(() => {
    if (!aiItems) return null;
    return aiItems.filter(
      (x) => (filters.kind === 'all' || x.judgeKind === filters.kind) && (!strict || x.relation === 'direct'),
    );
  }, [aiItems, filters.kind, strict]);
  const hiddenSimilar = useMemo(() => {
    if (!aiItems || !strict) return 0;
    return aiItems.filter((x) => (filters.kind === 'all' || x.judgeKind === filters.kind) && x.relation !== 'direct').length;
  }, [aiItems, filters.kind, strict]);
  const relationById = useMemo(() => {
    if (!aiShown) return null;
    return new Map(aiShown.map((x) => [x.article.id, x.relation]));
  }, [aiShown]);
  // resultado restaurado do histórico: quantos hits salvos não existem mais no acervo (purge/re-export)
  const aiMissing = aiActive && ai.result.frozen ? ai.result.hits.length - (aiItems?.length ?? 0) : 0;

  // resultados IA não têm bucket release: se estava selecionado, volta pro Tudo
  useEffect(() => {
    if ((aiLive || aiActive) && filters.kind === 'release') {
      dispatch({ type: 'set', key: 'kind', value: 'all' });
    }
  }, [ai.phase, aiActive, filters.kind]);

  const displayItems = aiShown ? aiShown.map((x) => x.article) : filtered;
  // Itens do player de áudio: a lista EXIBIDA (na ordem da tela) reduzida ao que o TTS narra
  // (id + título p/ rótulo + summary_pt como conteúdo). Itens sem resumo são pulados no player.
  const playerItems = useMemo(
    () => displayItems.map((a) => ({ id: a.id, title: a.title_pt || a.title || a.url, text: a.summary_pt || a.snippet || '' })),
    [displayItems],
  );
  const resetKey = useMemo(
    () => JSON.stringify(filters) + `|q:${textQuery}` + (aiActive ? `|ai:${ai.result.query}:${ai.result.hits.length}` : ''),
    [filters, textQuery, aiActive, ai.result],
  );
  const pagedVisible = useVisibleCount(displayItems.length, resetKey);
  // IA (running E done): mostra TODOS os hits sem paginar — assim o resultado NÃO encolhe/pula ao
  // terminar (os cards que apareceram ao vivo permanecem). Só o browse (SQL) segue paginado.
  const visible = aiLive || aiActive ? displayItems.length : pagedVisible;
  const nActive = countActiveFilters(filters);
  const detail = detailId != null ? byId.get(detailId) : null;

  return (
    <PlayerProvider items={playerItems} audio={meta?.audio} onNeedKey={ai.openKeyModal}>
    <div className="app">
      <TopBar
        theme={theme}
        onToggleTheme={toggle}
        onHelp={() => setTutorialOpen(true)}
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
                  <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                    <path d="M2.2 3h11.6l-4.4 5.2v4.1l-2.8 1.4V8.2L2.2 3Z" strokeLinejoin="round" strokeLinecap="round" />
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
                <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                  <path d="M2.6 8a5.4 5.4 0 105.4-5.4c-1.9 0-3.6 1-4.5 2.5" strokeLinecap="round" />
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
          {isDesktop && meta && <Sidebar meta={meta} filters={filters} dispatch={dispatch} facetCounts={facetCounts} />}
          <section className="content">
            <div className="content-head">
              <Segmented
                value={filters.kind}
                options={aiActive || aiLive ? KIND_OPTIONS_AI : KIND_OPTIONS}
                onChange={(v) => dispatch({ type: 'set', key: 'kind', value: v })}
                label={STR.kindLabel}
              />
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

            {ai.spec && (ai.spec.must_have?.length || ai.spec.query_en) && (
              <div className="spec-banner" aria-live="polite">
                <span className="spec-label">{STR.specLabel}:</span>
                {(ai.spec.must_have || []).map((m, i) => (
                  <span key={i} className="spec-chip">{m}</span>
                ))}
                {ai.spec.query_en && <span className="spec-en">EN: {ai.spec.query_en}</span>}
                {hiddenSimilar > 0 && <span className="spec-hidden">{STR.specHidden(hiddenSimilar)}</span>}
              </div>
            )}

            {ai.phase === 'running' && (
              <AiProgress progress={ai.progress} deep={ai.deep} startedAt={ai.startedAt} resuming={ai.resuming} baseDone={ai.baseDone} onCancel={ai.cancel} />
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
            {aiActive && <AiBanner result={ai.result} missing={aiMissing} onClear={ai.clear} onRerun={() => ai.submit(ai.result.query, ai.result.deep)} />}
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

            {!aiActive && !aiLive && meta && <ActivePills filters={filters} meta={meta} dispatch={dispatch} />}

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
        />
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
    </div>
    </PlayerProvider>
  );
}
