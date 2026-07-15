import { useCallback, useEffect, useRef, useState } from 'react';
import { getContent } from '../lib/data.js';
import { estimateSearch } from '../lib/cost.js';
import { runSearch } from '../lib/search.js';
import { probeKey } from '../lib/openrouter.js';
import { applyFilters, EMPTY_FILTERS } from '../lib/filters.js';
import { clearApiKey, getApiKey, setApiKey } from '../lib/storage.js';
import { addToHistory, clearHistory, loadHistory, removeFromHistory } from '../lib/history.js';
import { clearActiveSearch, loadActiveSearch, makeCheckpointWriter, saveActiveSearch } from '../lib/activeSearch.js';
import { useStrings } from '../i18n.jsx';

// Depois de N retomadas automáticas SEM avanço (erro determinístico), para de auto-retomar e
// oferece o botão manual — evita loop de reload↔retomada↔erro.
const MAX_AUTO_RESUME = 2;

/**
 * Máquina de estados da busca IA (BYOK): idle → (keyModal) → confirm → running → done|error.
 * O ESCOPO da busca = fonte+período dos filtros atuais (paridade com SEARCH_SCOPE_WHERE do CLI;
 * facetas/kind/verify NÃO limitam o escopo). UMA busca por vez (substitui o 409 do servidor);
 * Cancelar ABORTA de verdade as chamadas em voo. Chave inválida (401) limpa a salva e reabre
 * o modal com a busca pendente — salvar re-dispara sozinho.
 *
 * RETOMADA (lib/activeSearch.js): enquanto roda, um checkpoint "de troca rápida" no localStorage
 * guarda os ids já julgados + hits + custo. Um reload / fechar-e-reabrir a aba RE-HIDRATA e AUTO-
 * RETOMA de onde parou (sem repagar o já julgado); só o Cancelar ATIVO descarta. `phase:'paused'`
 * é a retomada manual (chave ausente / guarda anti-loop).
 */
export function useAiSearch({ articles, meta, filters }) {
  const STR = useStrings();
  const [state, setState] = useState({
    phase: 'idle', query: '', deep: false, progress: null, result: null, error: null,
    partialHits: [], spec: null, startedAt: null, resuming: false, baseDone: 0, // streaming + retomada
  });
  const [confirmInfo, setConfirmInfo] = useState(null); // {query, deep, count, calls, usd, candidates, scope}
  const [keyModal, setKeyModal] = useState(null); // {pending:{query,deep,scope,resume}|null, reason:'missing'|'invalid'|'manage'}
  const [sessionUsd, setSessionUsd] = useState(0); // gasto REAL acumulado da sessão (CostBadge)
  const [hasKey, setHasKey] = useState(() => Boolean(getApiKey())); // reativo p/ o botão de chave da topbar
  const [history, setHistory] = useState(() => loadHistory()); // buscas salvas (localStorage)
  const [resumeInfo, setResumeInfo] = useState(null); // {query, scope} p/ o App sincronizar campo+pills
  const abortRef = useRef(null);
  const writerRef = useRef(null); // writer (throttle) do checkpoint da run atual
  const metaRef = useRef({ startedAt: 0, resumeAttempts: 0, baseScanned: 0 }); // meta do checkpoint (RMW-safe)
  const resumedRef = useRef(false); // efeito de retomada roda uma vez só

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
    async ({ query, deep, candidates, scope = {}, resume = null }) => {
      const apiKey = getApiKey();
      const controller = new AbortController();
      abortRef.current?.abort(); // evita 2 buscas concorrentes (race de submit/retomada)
      abortRef.current = controller;
      setConfirmInfo(null);

      // meta do checkpoint desta run: o writer SEMPRE grava a partir do ref (evita corrida read-
      // modify-write do resumeAttempts). Retomada incrementa a tentativa; progresso real zera (abaixo).
      const resumeAttempts = resume ? (resume.resumeAttempts || 0) + 1 : 0;
      const seededScanned = resume ? resume.scanned || 0 : 0;
      metaRef.current = { startedAt: Date.now(), resumeAttempts, baseScanned: seededScanned };

      const savedScope = { sourceId: scope.sourceId ?? null, from: scope.from || '', to: scope.to || '' };
      if (!resume) clearActiveSearch(); // busca NOVA limpa o slot antes de recriar
      writerRef.current = makeCheckpointWriter({
        write: (data) =>
          saveActiveSearch({
            query, deep, scope: savedScope,
            resumeAttempts: metaRef.current.resumeAttempts,
            updatedAt: Date.now(),
            ...data,
          }),
      });

      const seededHits = resume ? (resume.hits || []).map((h) => ({ id: h.id, relation: h.relation, kind: h.kind })) : [];
      const seededSpec = resume ? resume.spec || null : null;
      setState({
        phase: 'running', query, deep,
        progress: resume
          ? { mode: deep ? 'deep' : 'soft', done: seededScanned, total: resume.total || 0, relevant: resume.relevant ?? seededHits.length, failed: resume.failed || 0, spentUsd: resume.spentUsd || 0 }
          : null,
        result: null, error: null,
        partialHits: seededHits, spec: seededSpec, startedAt: metaRef.current.startedAt,
        resuming: Boolean(resume), baseDone: seededScanned,
      });

      let lastSpent = resume ? resume.spentUsd || 0 : 0;
      if (resume && lastSpent > 0) setSessionUsd((v) => v + lastSpent); // badge mostra o custo ACUMULADO
      let capturedSpec = seededSpec;
      try {
        const result = await runSearch({
          query,
          deep,
          candidates,
          search: meta.search,
          apiKey,
          signal: controller.signal,
          getContent,
          resume,
          onCheckpoint: (build) => writerRef.current?.push(build),
          onSpec: (spec) => {
            capturedSpec = spec; // o "entendimento" chega antes dos hits (banner ao vivo)
            setState((s) => (s.phase === 'running' ? { ...s, spec } : s));
          },
          onProgress: (p) => {
            setState((s) => (s.phase === 'running' ? { ...s, progress: p, resuming: false } : s));
            if (p.spentUsd > lastSpent) {
              setSessionUsd((v) => v + (p.spentUsd - lastSpent));
              lastSpent = p.spentUsd;
            }
            // avanço REAL na retomada → zera o guarda anti-loop (persiste no próximo checkpoint)
            if (metaRef.current.resumeAttempts !== 0 && p.done > metaRef.current.baseScanned) {
              metaRef.current.resumeAttempts = 0;
            }
          },
          onHit: (hit) => {
            // streaming: cada hit relevante entra no grid AO VIVO (App lê partialHits na fase running)
            setState((s) => (s.phase === 'running' ? { ...s, partialHits: [...s.partialHits, hit] } : s));
          },
        });
        if (result.spentUsd > lastSpent) setSessionUsd((v) => v + (result.spentUsd - lastSpent));
        // CONCLUÍDA: sai do slot de "em andamento" e entra no histórico (frozen), idêntico a reabrir.
        writerRef.current?.cancel();
        clearActiveSearch();
        const saved = addToHistory({ ...result, spec: capturedSpec }, scope);
        setHistory(saved);
        const entry = saved[0];
        setState({
          phase: 'done', query, deep, progress: null,
          result: entry ? { ...result, frozen: true, id: entry.id, createdAt: entry.createdAt } : result,
          error: null, partialHits: [], spec: capturedSpec, startedAt: null, resuming: false, baseDone: 0,
        });
      } catch (e) {
        if (controller.signal.aborted || e?.name === 'AbortError') {
          // ABORT: só o Cancelar ATIVO limpa o checkpoint (feito em cancel()). Reload/navegação NÃO
          // passam por aqui (a página é destruída) — por isso reload NÃO descarta e retoma no próximo mount.
          setState({ phase: 'idle', query: '', deep, progress: null, result: null, error: null, partialHits: [], spec: null, startedAt: null, resuming: false, baseDone: 0 });
          return;
        }
        if (e?.code === 'KEY_INVALID') {
          clearApiKey();
          setHasKey(false);
          writerRef.current?.flush(); // preserva o progresso p/ retomar depois de salvar a chave nova
          setKeyModal({ pending: { query, deep, scope, resume: loadActiveSearch() }, reason: 'invalid' });
          setState({ phase: 'idle', query: '', deep, progress: null, result: null, error: null, partialHits: [], spec: null, startedAt: null, resuming: false, baseDone: 0 });
          return;
        }
        // ERRO transitório: MANTÉM o checkpoint (um reload retoma); só mostra o erro.
        writerRef.current?.flush();
        setState({ phase: 'error', query, deep, progress: null, result: null, error: e.message || String(e), partialHits: [], spec: null, startedAt: null, resuming: false, baseDone: 0 });
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

  // Retoma um checkpoint: recomputa os candidatos do escopo SALVO (não dos filtros atuais) e chama
  // start com `resume` — runSearch pula os ids já julgados e re-dispara só o que faltava.
  const resumeFromCheckpoint = useCallback(
    (cp) => {
      if (!cp || !articles) return;
      const candidates = scopeCandidates(cp.scope || {});
      start({ query: cp.query, deep: cp.deep, candidates, scope: cp.scope || {}, resume: cp });
    },
    [articles, scopeCandidates, start],
  );

  // Reload no EXATO fim (todos os candidatos julgados, mas o done-path não chegou a rodar): fecha,
  // salva no histórico e limpa — sem re-chamar a IA.
  const finalizeFromCheckpoint = useCallback(
    (cp, candidates) => {
      const hits = (cp.hits || []).map((h) => ({ id: h.id, relation: h.relation, kind: h.kind }));
      const result = {
        query: cp.query, deep: cp.deep,
        scanned: cp.scanned || 0, total: candidates.length,
        relevant: hits.length, failed: cp.failed || 0,
        truncated: hits.length > (meta?.search?.maxItems || 500),
        spentUsd: cp.spentUsd || 0, hits, spec: cp.spec || null,
      };
      clearActiveSearch();
      if (cp.spentUsd) setSessionUsd((v) => v + cp.spentUsd);
      const saved = addToHistory({ ...result, spec: cp.spec || null }, cp.scope || {});
      setHistory(saved);
      const entry = saved[0];
      setState({
        phase: 'done', query: cp.query, deep: cp.deep, progress: null,
        result: entry ? { ...result, frozen: true, id: entry.id, createdAt: entry.createdAt } : result,
        error: null, partialHits: [], spec: cp.spec || null, startedAt: null, resuming: false, baseDone: 0,
      });
    },
    [meta],
  );

  // Retomada MANUAL (chave ausente ao reabrir / guarda anti-loop): re-hidrata os parciais e espera
  // o clique em "Retomar" (resumeManual) ou "Descartar" (discardResume).
  const hydratePaused = useCallback((cp) => {
    const hits = (cp.hits || []).map((h) => ({ id: h.id, relation: h.relation, kind: h.kind }));
    if (cp.spentUsd) setSessionUsd((v) => v + cp.spentUsd);
    setState({
      phase: 'paused', query: cp.query, deep: cp.deep,
      progress: { mode: cp.deep ? 'deep' : 'soft', done: cp.scanned || 0, total: cp.total || 0, relevant: hits.length, failed: cp.failed || 0, spentUsd: cp.spentUsd || 0 },
      result: null, error: null, partialHits: hits, spec: cp.spec || null, startedAt: null, resuming: false, baseDone: 0,
    });
  }, []);

  const resumeManual = useCallback(() => {
    const cp = loadActiveSearch();
    if (cp) resumeFromCheckpoint(cp);
  }, [resumeFromCheckpoint]);

  const discardResume = useCallback(() => {
    writerRef.current?.cancel();
    clearActiveSearch();
    abortRef.current?.abort();
    setState({ phase: 'idle', query: '', deep: false, progress: null, result: null, error: null, partialHits: [], spec: null, startedAt: null, resuming: false, baseDone: 0 });
  }, []);

  // AUTO-RETOMADA no mount: assim que o snapshot chega, se houver checkpoint com trabalho pendente,
  // re-hidrata e retoma (ou pede a chave / oferece retomada manual). Roda UMA vez (resumedRef).
  useEffect(() => {
    if (resumedRef.current) return;
    if (!articles || !meta?.search) return; // espera o snapshot carregar p/ recomputar candidatos
    resumedRef.current = true;
    const cp = loadActiveSearch();
    if (!cp) return;
    const candidates = scopeCandidates(cp.scope || {});
    const judged = new Set(cp.judgedIds || []);
    const remaining = candidates.filter((a) => !judged.has(a.id));
    setResumeInfo({ query: cp.query, scope: cp.scope || {} }); // App sincroniza o campo + pills
    if (!remaining.length) return finalizeFromCheckpoint(cp, candidates);
    if (!getApiKey()) {
      hydratePaused(cp);
      setKeyModal({ pending: { query: cp.query, deep: cp.deep, scope: cp.scope, resume: cp }, reason: 'missing' });
      return;
    }
    if ((cp.resumeAttempts || 0) >= MAX_AUTO_RESUME) return hydratePaused(cp); // guarda anti-loop
    resumeFromCheckpoint(cp);
    // deps mínimos de propósito: o resumedRef garante execução única quando o snapshot fica pronto.
  }, [articles, meta]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flush síncrono do checkpoint ao esconder/fechar a aba: captura o estado MAIS novo antes do
  // teardown (setItem é síncrono), minimizando o re-trabalho na retomada.
  useEffect(() => {
    const flush = () => writerRef.current?.flush();
    const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // Reabre uma busca salva SEM custo: vira um resultado "done" CONGELADO (App re-hidrata os hits
  // via byId). Devolve a entrada p/ o App restaurar o escopo nos filtros (pills coerentes).
  const restore = useCallback((id) => {
    const entry = loadHistory().find((e) => e.id === id);
    if (!entry) return null;
    writerRef.current?.cancel();
    clearActiveSearch(); // não deixa um checkpoint órfão que o próximo reload retomaria
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
      resuming: false,
      baseDone: 0,
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

  // Cancelar ATIVO: ÚNICO caminho que descarta a busca sem retomar → limpa o checkpoint + aborta.
  const cancel = useCallback(() => {
    writerRef.current?.cancel();
    clearActiveSearch();
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    writerRef.current?.cancel();
    clearActiveSearch();
    abortRef.current?.abort();
    setState({ phase: 'idle', query: '', deep: false, progress: null, result: null, error: null, partialHits: [], spec: null, startedAt: null, resuming: false, baseDone: 0 });
  }, []);

  /** Valida via probe e salva; com busca pendente, re-dispara (retomada se havia checkpoint). */
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
      if (pending?.resume) resumeFromCheckpoint(pending.resume); // RETOMA (não repaga o já julgado)
      else if (pending) run(pending.query, pending.deep, pending.scope || { sourceId: filters.sourceId, from: filters.from, to: filters.to });
    },
    [keyModal, run, resumeFromCheckpoint, filters, STR],
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
    resumeInfo,
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
    resumeManual,
    discardResume,
  };
}
