import { useCallback, useRef, useState } from 'react';
import { getContent } from '../lib/data.js';
import { estimateSearch } from '../lib/cost.js';
import { runSearch } from '../lib/search.js';
import { probeKey } from '../lib/openrouter.js';
import { applyFilters, EMPTY_FILTERS } from '../lib/filters.js';
import { clearApiKey, getApiKey, setApiKey } from '../lib/storage.js';
import { addToHistory, clearHistory, loadHistory, removeFromHistory } from '../lib/history.js';
import { useStrings } from '../i18n.jsx';

/**
 * Máquina de estados da busca IA (BYOK): idle → (keyModal) → confirm → running → done|error.
 * O ESCOPO da busca = fonte+período dos filtros atuais (paridade com SEARCH_SCOPE_WHERE do CLI;
 * facetas/kind/verify NÃO limitam o escopo). UMA busca por vez (substitui o 409 do servidor);
 * Cancelar ABORTA de verdade as chamadas em voo. Chave inválida (401) limpa a salva e reabre
 * o modal com a busca pendente — salvar re-dispara sozinho.
 */
export function useAiSearch({ articles, meta, filters }) {
  const STR = useStrings();
  const [state, setState] = useState({
    phase: 'idle', query: '', deep: false, progress: null, result: null, error: null,
    partialHits: [], spec: null, startedAt: null, // streaming: hits ao vivo + spec + t0 p/ o ETA do loader
  });
  const [confirmInfo, setConfirmInfo] = useState(null); // {query, deep, count, calls, usd, candidates, scope}
  const [keyModal, setKeyModal] = useState(null); // {pending:{query,deep,scope}|null, reason:'missing'|'invalid'|'manage'}
  const [sessionUsd, setSessionUsd] = useState(0); // gasto REAL acumulado da sessão (CostBadge)
  const [hasKey, setHasKey] = useState(() => Boolean(getApiKey())); // reativo p/ o botão de chave da topbar
  const [history, setHistory] = useState(() => loadHistory()); // buscas salvas (localStorage)
  const abortRef = useRef(null);

  const scopeCandidates = useCallback(
    (f) =>
      applyFilters(
        articles || [],
        { ...EMPTY_FILTERS, sourceId: f.sourceId, from: f.from, to: f.to },
        meta?.toolContentTypes || [],
      ),
    [articles, meta],
  );

  const start = useCallback(
    async ({ query, deep, candidates, scope = {} }) => {
      const apiKey = getApiKey();
      const controller = new AbortController();
      abortRef.current = controller;
      setConfirmInfo(null);
      setState({ phase: 'running', query, deep, progress: null, result: null, error: null, partialHits: [], spec: null, startedAt: Date.now() });
      let lastSpent = 0;
      let capturedSpec = null;
      try {
        const result = await runSearch({
          query,
          deep,
          candidates,
          search: meta.search,
          apiKey,
          signal: controller.signal,
          getContent,
          onSpec: (spec) => {
            capturedSpec = spec; // o "entendimento" chega antes dos hits (banner ao vivo)
            setState((s) => (s.phase === 'running' ? { ...s, spec } : s));
          },
          onProgress: (p) => {
            setState((s) => (s.phase === 'running' ? { ...s, progress: p } : s));
            if (p.spentUsd > lastSpent) {
              setSessionUsd((v) => v + (p.spentUsd - lastSpent));
              lastSpent = p.spentUsd;
            }
          },
          onHit: (hit) => {
            // streaming: cada hit relevante entra no grid AO VIVO (App lê partialHits na fase running)
            setState((s) => (s.phase === 'running' ? { ...s, partialHits: [...s.partialHits, hit] } : s));
          },
        });
        if (result.spentUsd > lastSpent) setSessionUsd((v) => v + (result.spentUsd - lastSpent));
        // auto-salva (com o spec) e apresenta a busca concluída COMO a entrada recém-salva do
        // histórico (frozen): os cards permanecem na tela e o banner mostra que já está salvo —
        // idêntico a reabrir do histórico (pedido do usuário). fail-open se o save falhar.
        const saved = addToHistory({ ...result, spec: capturedSpec }, scope);
        setHistory(saved);
        const entry = saved[0];
        setState({
          phase: 'done', query, deep, progress: null,
          result: entry ? { ...result, frozen: true, id: entry.id, createdAt: entry.createdAt } : result,
          error: null, partialHits: [], spec: capturedSpec, startedAt: null,
        });
      } catch (e) {
        if (controller.signal.aborted || e?.name === 'AbortError') {
          setState({ phase: 'idle', query: '', deep, progress: null, result: null, error: null, partialHits: [], startedAt: null });
          return;
        }
        if (e?.code === 'KEY_INVALID') {
          clearApiKey();
          setHasKey(false);
          setKeyModal({ pending: { query, deep }, reason: 'invalid' });
          setState({ phase: 'idle', query: '', deep, progress: null, result: null, error: null, partialHits: [], startedAt: null });
          return;
        }
        setState({ phase: 'error', query, deep, progress: null, result: null, error: e.message || String(e), partialHits: [], startedAt: null });
      } finally {
        abortRef.current = null;
      }
    },
    [meta],
  );

  // Dispara com um ESCOPO explícito {sourceId, from, to} — o re-rodar do histórico usa o escopo
  // salvo (não os filtros atuais), então a busca reproduz o mesmo recorte independentemente do
  // que estiver selecionado na tela.
  const run = useCallback(
    (query, deep, scope) => {
      const q = String(query || '').trim();
      if (!q || !articles || state.phase === 'running') return;
      if (!getApiKey()) {
        setKeyModal({ pending: { query: q, deep, scope }, reason: 'missing' });
        return;
      }
      const candidates = scopeCandidates(scope);
      if (!candidates.length) {
        setState((s) => ({ ...s, phase: 'error', query: q, deep, error: STR.aiEmptyScope }));
        return;
      }
      const { calls, usd, needsConfirm } = estimateSearch({ count: candidates.length, deep, search: meta.search });
      if (needsConfirm) setConfirmInfo({ query: q, deep, count: candidates.length, calls, usd, candidates, scope });
      else start({ query: q, deep, candidates, scope });
    },
    [articles, meta, scopeCandidates, start, state.phase, STR],
  );

  const submit = useCallback(
    (query, deep) => run(query, deep, { sourceId: filters.sourceId, from: filters.from, to: filters.to }),
    [run, filters],
  );

  // Reabre uma busca salva SEM custo: vira um resultado "done" CONGELADO (App re-hidrata os hits
  // via byId). Devolve a entrada p/ o App restaurar o escopo nos filtros (pills coerentes).
  const restore = useCallback((id) => {
    const entry = loadHistory().find((e) => e.id === id);
    if (!entry) return null;
    abortRef.current?.abort();
    setState({
      phase: 'done',
      query: entry.query,
      deep: entry.deep,
      progress: null,
      result: { ...entry.stats, query: entry.query, deep: entry.deep, hits: entry.hits, frozen: true, createdAt: entry.createdAt, id: entry.id },
      error: null,
      partialHits: [],
      spec: entry.spec || null, // reabre com o "entendimento" salvo (banner sem repagar)
      startedAt: null,
    });
    return entry;
  }, []);

  // Re-roda uma busca salva com o MESMO escopo (passa pela confirmação de custo usual).
  const rerun = useCallback(
    (id) => {
      const entry = loadHistory().find((e) => e.id === id);
      if (entry) run(entry.query, entry.deep, entry.scope || {});
      return entry || null;
    },
    [run],
  );

  const removeEntry = useCallback((id) => setHistory(removeFromHistory(id)), []);
  const clearAll = useCallback(() => setHistory(clearHistory()), []);

  const confirm = useCallback(() => {
    if (confirmInfo) start(confirmInfo);
  }, [confirmInfo, start]);

  const cancelConfirm = useCallback(() => setConfirmInfo(null), []);

  /** Abre o modal de chave PROATIVAMENTE (botão da topbar): gerenciar se já tem, senão pedir. */
  const openKeyModal = useCallback(() => {
    setKeyModal({ pending: null, reason: getApiKey() ? 'manage' : 'missing' });
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setState({ phase: 'idle', query: '', deep: false, progress: null, result: null, error: null, partialHits: [], startedAt: null });
  }, []);

  /** Valida via probe e salva; com busca pendente, re-dispara. LANÇA mensagem p/ o modal exibir. */
  const saveKey = useCallback(
    async (key) => {
      const k = String(key || '').trim();
      if (!k) throw new Error(STR.keyInvalid);
      const probe = await probeKey(k);
      if (!probe.ok) throw new Error(probe.status === 0 ? STR.keyNetwork : STR.keyInvalid);
      setApiKey(k);
      setHasKey(true);
      const pending = keyModal?.pending;
      setKeyModal(null);
      // re-dispara a busca pendente com o MESMO escopo que a originou (não os filtros atuais)
      if (pending) run(pending.query, pending.deep, pending.scope || { sourceId: filters.sourceId, from: filters.from, to: filters.to });
    },
    [keyModal, run, filters],
  );

  const dismissKey = useCallback(() => setKeyModal(null), []);
  const forgetKey = useCallback(() => {
    clearApiKey();
    setHasKey(false);
    setKeyModal(null);
  }, []);

  return {
    ...state,
    confirmInfo,
    keyModal,
    sessionUsd,
    hasKey,
    history,
    submit,
    confirm,
    cancelConfirm,
    openKeyModal,
    cancel,
    clear,
    saveKey,
    dismissKey,
    forgetKey,
    restore,
    rerun,
    removeEntry,
    clearAll,
  };
}
