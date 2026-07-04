import { useCallback, useRef, useState } from 'react';
import { getContent } from '../lib/data.js';
import { estimateSearch } from '../lib/cost.js';
import { runSearch } from '../lib/search.js';
import { probeKey } from '../lib/openrouter.js';
import { applyFilters, EMPTY_FILTERS } from '../lib/filters.js';
import { clearApiKey, getApiKey, setApiKey } from '../lib/storage.js';
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
    partialHits: [], startedAt: null, // streaming: hits ao vivo + t0 p/ o ETA do loader
  });
  const [confirmInfo, setConfirmInfo] = useState(null); // {query, deep, count, calls, usd, candidates}
  const [keyModal, setKeyModal] = useState(null); // {pending:{query,deep}|null, reason:'missing'|'invalid'|'manage'}
  const [sessionUsd, setSessionUsd] = useState(0); // gasto REAL acumulado da sessão (CostBadge)
  const [hasKey, setHasKey] = useState(() => Boolean(getApiKey())); // reativo p/ o botão de chave da topbar
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
    async ({ query, deep, candidates }) => {
      const apiKey = getApiKey();
      const controller = new AbortController();
      abortRef.current = controller;
      setConfirmInfo(null);
      setState({ phase: 'running', query, deep, progress: null, result: null, error: null, partialHits: [], startedAt: Date.now() });
      let lastSpent = 0;
      try {
        const result = await runSearch({
          query,
          deep,
          candidates,
          search: meta.search,
          apiKey,
          signal: controller.signal,
          getContent,
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
        setState({ phase: 'done', query, deep, progress: null, result, error: null, partialHits: [], startedAt: null });
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

  const submit = useCallback(
    (query, deep) => {
      const q = String(query || '').trim();
      if (!q || !articles || state.phase === 'running') return;
      if (!getApiKey()) {
        setKeyModal({ pending: { query: q, deep }, reason: 'missing' });
        return;
      }
      const candidates = scopeCandidates(filters);
      if (!candidates.length) {
        setState((s) => ({ ...s, phase: 'error', query: q, deep, error: STR.aiEmptyScope }));
        return;
      }
      const { calls, usd, needsConfirm } = estimateSearch({ count: candidates.length, deep, search: meta.search });
      if (needsConfirm) setConfirmInfo({ query: q, deep, count: candidates.length, calls, usd, candidates });
      else start({ query: q, deep, candidates });
    },
    [articles, filters, meta, scopeCandidates, start, state.phase, STR],
  );

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
      if (pending) submit(pending.query, pending.deep);
    },
    [keyModal, submit, STR],
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
    submit,
    confirm,
    cancelConfirm,
    openKeyModal,
    cancel,
    clear,
    saveKey,
    dismissKey,
    forgetKey,
  };
}
