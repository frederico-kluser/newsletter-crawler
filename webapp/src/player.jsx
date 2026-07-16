// Player de áudio (TTS): UM único <audio>, UMA reprodução por vez. O botão ao lado da busca toca
// a lista FILTRADA (displayItems) em sequência — uma notícia por vez até parar ou acabar; o botão
// de cada card toca só aquele resumo (interrompe o play-all). Busca o áudio SOB DEMANDA por item
// (nunca pré-gera tudo — não paga o que não toca) e cacheia por id na sessão (revoga no unmount).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { synthesize, AUDIO_DEFAULTS } from './lib/tts.js';
import { getApiKey } from './lib/storage.js';
import { KeyInvalidError } from './lib/openrouter.js';

const PlayerContext = createContext(null);

/** Controles do player; retorna null fora do provider (ex.: card em teste isolado). */
export function usePlayer() {
  return useContext(PlayerContext);
}

export function PlayerProvider({ children, items = [], audio, onNeedKey }) {
  const cfg = useMemo(() => ({ ...AUDIO_DEFAULTS, ...(audio || {}) }), [audio]);

  const audioElRef = useRef(null);
  const cacheRef = useRef(new Map()); // id -> objectURL
  const queueRef = useRef([]); // lista viva a tocar em 'all'
  const idxRef = useRef(-1);
  const modeRef = useRef(null); // 'all' | 'one' | null
  const abortRef = useRef(null); // AbortController do fetch em voo
  const tokenRef = useRef(0); // invalida fetch obsoleto ao trocar de item
  const advanceRef = useRef(() => {}); // aponta p/ o advance mais novo (listener estável)

  const [playing, setPlaying] = useState(false);
  const [currentId, setCurrentId] = useState(null);
  const [loadingId, setLoadingId] = useState(null);

  // fila viva: a lista exibida muda com filtros/busca sem recriar o provider
  queueRef.current = items;

  const clearInFlight = useCallback(() => {
    tokenRef.current += 1; // qualquer fetch anterior vira obsoleto
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    clearInFlight();
    modeRef.current = null;
    idxRef.current = -1;
    const el = audioElRef.current;
    if (el) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    setPlaying(false);
    setCurrentId(null);
    setLoadingId(null);
  }, [clearInFlight]);

  // Resolve o objectURL do item (cache por id → senão sintetiza). Lança em erro/chave inválida.
  const getUrl = useCallback(
    async (item, signal) => {
      const cached = cacheRef.current.get(item.id);
      if (cached) return cached;
      const blob = await synthesize({
        apiKey: getApiKey(),
        text: item.text,
        model: cfg.model,
        voice: cfg.voice,
        format: cfg.format,
        signal,
      });
      const url = URL.createObjectURL(blob);
      cacheRef.current.set(item.id, url);
      return url;
    },
    [cfg],
  );

  // Toca UM item. O comportamento do fim (avançar/parar) vem de modeRef, lido no onended.
  const playItem = useCallback(
    async (item) => {
      if (!item || !item.text) {
        advanceRef.current();
        return;
      }
      clearInFlight();
      const token = tokenRef.current;
      const ac = new AbortController();
      abortRef.current = ac;
      setCurrentId(item.id);
      setLoadingId(item.id);
      setPlaying(true);
      try {
        const url = await getUrl(item, ac.signal);
        if (token !== tokenRef.current) return; // outro play/stop assumiu no meio
        const el = audioElRef.current;
        el.src = url;
        setLoadingId(null);
        // prefetch do PRÓXIMO em 'all' (aquece o cache; não bloqueia nem repaga)
        if (modeRef.current === 'all') {
          const nxt = queueRef.current[idxRef.current + 1];
          if (nxt && nxt.text && !cacheRef.current.has(nxt.id)) getUrl(nxt).catch(() => {});
        }
        await el.play();
      } catch (e) {
        if (token !== tokenRef.current || e?.name === 'AbortError') return; // cancelado
        setLoadingId(null);
        if (e instanceof KeyInvalidError) {
          stop();
          onNeedKey?.();
          return;
        }
        // erro do item: em 'all' pula p/ o próximo; em 'one' encerra
        if (modeRef.current === 'all') advanceRef.current();
        else stop();
      }
    },
    [clearInFlight, getUrl, onNeedKey, stop],
  );

  // Avança na fila 'all' (onended e erro de item). Pula itens sem resumo.
  const advance = useCallback(() => {
    if (modeRef.current !== 'all') {
      stop();
      return;
    }
    const q = queueRef.current;
    let next = idxRef.current + 1;
    while (next < q.length && !q[next].text) next += 1;
    if (next >= q.length) {
      stop();
      return;
    }
    idxRef.current = next;
    playItem(q[next]);
  }, [playItem, stop]);
  advanceRef.current = advance;

  const playAll = useCallback(() => {
    const q = queueRef.current;
    const first = q.findIndex((x) => x.text);
    if (first === -1) return; // nada narrável
    if (!getApiKey()) {
      onNeedKey?.();
      return;
    }
    clearInFlight();
    modeRef.current = 'all';
    idxRef.current = first;
    playItem(q[first]);
  }, [clearInFlight, playItem, onNeedKey]);

  const playOne = useCallback(
    (item) => {
      if (!item || !item.text) return;
      if (!getApiKey()) {
        onNeedKey?.();
        return;
      }
      clearInFlight();
      modeRef.current = 'one';
      idxRef.current = -1;
      playItem(item);
    },
    [clearInFlight, playItem, onNeedKey],
  );

  // <audio> criado uma vez; o listener estável chama o advance mais novo via ref.
  useEffect(() => {
    const el = new Audio();
    audioElRef.current = el;
    const onEnded = () => advanceRef.current();
    el.addEventListener('ended', onEnded);
    const cache = cacheRef.current;
    return () => {
      el.pause();
      el.removeEventListener('ended', onEnded);
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    };
  }, []);

  const hasItems = useMemo(() => items.some((x) => x.text), [items]);

  const value = useMemo(
    () => ({
      playing,
      currentId,
      loadingId,
      hasItems,
      playAll,
      playOne,
      stop,
      toggleAll: () => (playing ? stop() : playAll()),
    }),
    [playing, currentId, loadingId, hasItems, playAll, playOne, stop],
  );
  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}
