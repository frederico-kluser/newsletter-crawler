// Buscador — app React zero-build: React/ReactDOM chegam como globals (UMD em /vendor) e o
// htm (tagged templates) faz o papel do JSX, exatamente como na TUI Ink. Strings em PT-BR.
import htm from '/vendor/htm.js';

const { useState, useEffect, useRef, useCallback, Fragment } = React;
const html = htm.bind(React.createElement);
// htm NÃO entende o fragment "nu" <>…</> do JSX (viraria tag '' e o React aborta);
// fragments aqui são sempre <${Fragment}>…<//>.

const PAGE = 24;

const STR = {
  brand: 'newsletter-crawler',
  brandSep: ' · buscador',
  heroTitle: 'Todos os seus artigos.',
  heroSub: 'Pergunte à IA — ela lê o acervo e separa o que responde de verdade.',
  searchPlaceholder: 'Busque com IA: tema, pergunta, tecnologia…',
  clear: 'Limpar busca',
  segAll: 'Tudo',
  segNews: 'Notícias',
  segTools: 'Ferramentas',
  allSources: 'Todas as fontes',
  from: 'De',
  to: 'Até',
  last7: '7 dias',
  last30: '30 dias',
  filters: 'Filtros',
  clearFilters: 'Limpar filtros',
  results: (n) => `${n} ${n === 1 ? 'artigo' : 'artigos'}`,
  loadMore: 'Carregar mais',
  loading: 'Carregando…',
  emptyTitle: 'Nenhum artigo encontrado',
  emptyBody: 'Tente outra busca ou remova alguns filtros.',
  emptyDbTitle: 'Sua base ainda está vazia',
  emptyDbBody: 'Rode um crawl para arquivar os primeiros artigos:',
  errorTitle: 'Algo deu errado',
  retry: 'Tentar de novo',
  openOriginal: 'Ler o artigo original',
  close: 'Fechar',
  toolBadge: 'Ferramenta',
  releaseBadge: 'Release',
  costTitle: 'Custo de IA acumulado (todas as coletas)',
  verifyAll: 'Verificação: todas',
  verifyOk: 'ok',
  verifySuspect: 'suspect',
  verifyJunk: 'junk',
  verifyTitle: (v, notes) => `Verificação: ${v}${notes ? ` — ${notes}` : ''}`,
  theme: 'Alternar tema claro/escuro',
  showMore: (n) => `+ ${n} mais`,
  showLess: 'mostrar menos',
  noDate: 'sem data',
  // busca IA (soft em lote / profunda por artigo)
  searchBtn: 'Buscar',
  searchHint: 'Enter busca com IA · fonte e período limitam o escopo',
  searchDeep: 'Busca profunda',
  searchDeepHint: 'Lê o conteúdo completo de cada artigo do escopo (1 chamada de IA por artigo — mais cara e lenta).',
  searchSlowHint: 'Analisando com IA — a busca profunda pode levar alguns minutos…',
  searchSoftHint: 'Analisando com IA…',
  aiResultsFor: (q) => `Resultados da IA para “${q}”`,
  aiStats: (rel, total) => `${rel} relevante(s) de ${total} analisados`,
  aiTruncated: (n) => `mostrando os ${n} primeiros`,
  aiSkipped: (n) => `${n} não avaliados (orçamento)`,
  aiClear: 'Limpar resultados',
  relationDirect: 'Direta',
  relationSimilar: 'Similar',
  segReleases: 'Releases',
  confirmTitle: 'Confirmar busca com IA',
  confirmBody: (n, usd) => `O escopo atual tem ${n} artigo(s) — custo estimado ~US$ ${usd}. Rodar a busca?`,
  confirmRun: 'Rodar busca',
  cancel: 'Cancelar',
  busyMsg: 'Já existe uma busca em andamento — aguarde ela terminar.',
  scopeEmpty: 'O escopo atual (fonte/período) não tem nenhum artigo.',
  noResults: (q) => `A IA não achou nada relevante para “${q}”.`,
  searchFailed: 'A busca falhou — veja o terminal do servidor e tente de novo.',
  sourcesScope: 'Fontes no escopo',
  allSelected: 'todas',
  keyTitle: 'Configurar a chave do OpenRouter',
  keyBody: 'A busca por IA usa o OpenRouter (DeepSeek). Cole sua chave: ela é validada na API e salva em ~/.newsletter-crawler/.env — vale também para o CLI.',
  keyPlaceholder: 'sk-or-v1-…',
  keySave: 'Validar e salvar',
  keyChecking: 'Validando…',
  keyInvalid: 'Chave inválida (a API do OpenRouter recusou). Confira e tente de novo.',
  keyNetwork: 'Não deu para validar (sem rede?). Tente de novo.',
};

const FACET_LABEL = {
  domain: 'Domínio',
  'content-type': 'Tipo de conteúdo',
  'topic-technology': 'Tópicos e tecnologias',
  difficulty: 'Nível',
  'ecosystem-language': 'Linguagens',
  'company-vendor-model': 'Empresas e modelos',
  'framework-library-tool': 'Frameworks, libs e ferramentas',
  'concept-theme': 'Conceitos e temas',
  'trending-emerging': 'Tendências',
};

async function fetchJSON(url, signal) {
  const r = await fetch(url, { signal });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  return r.json();
}

// POST JSON sem timeout do lado do cliente (a busca profunda responde em minutos). Erros HTTP
// viram Error com {status, code, data} p/ o chamador rotear (409 ocupado, 428 confirmação, NO_KEY).
async function postJSON(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`);
    err.status = r.status;
    err.code = data.code;
    err.data = data;
    throw err;
  }
  return data;
}

const fmtDate = (iso) => {
  if (!iso) return STR.noDate;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return STR.noDate;
  // date-only (YYYY-MM-DD) parseia como meia-noite UTC; formatar no fuso local deslocaria 1 dia
  const opts = { day: 'numeric', month: 'short', year: 'numeric' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(iso).trim())) opts.timeZone = 'UTC';
  return d.toLocaleDateString('pt-BR', opts);
};
// published_at vem cru do scrape (pode ser imparseável); cai no extracted_at.
const bestDate = (a) => {
  const pub = a.published_at && !Number.isNaN(new Date(a.published_at).getTime());
  return fmtDate(pub ? a.published_at : a.extracted_at);
};
const dateOnly = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => dateOnly(new Date(Date.now() - n * 86400000));

// ---- ícones (SVG inline, traço fino estilo SF Symbols) ----
const Icon = {
  search: () => html`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="7" cy="7" r="5.2" stroke="currentColor" stroke-width="1.5" />
    <path d="M11 11l3.4 3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
  </svg>`,
  sun: () => html`<svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true">
    <circle cx="8.5" cy="8.5" r="3.4" stroke="currentColor" stroke-width="1.5" />
    <path d="M8.5 1v2M8.5 14v2M1 8.5h2M14 8.5h2M3.2 3.2l1.4 1.4M12.4 12.4l1.4 1.4M13.8 3.2l-1.4 1.4M4.6 12.4l-1.4 1.4"
      stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
  </svg>`,
  moon: () => html`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M13.8 9.6A6 6 0 116.4 2.2a4.8 4.8 0 007.4 7.4z" stroke="currentColor" stroke-width="1.5"
      stroke-linejoin="round" />
  </svg>`,
  empty: () => html`<svg width="44" height="44" viewBox="0 0 44 44" fill="none" aria-hidden="true">
    <circle cx="19" cy="19" r="12.5" stroke="currentColor" stroke-width="2" />
    <path d="M28.5 28.5l8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    <path d="M14 19h10" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
  </svg>`,
};

// ---- tema ----
function currentTheme() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'dark' || explicit === 'light') return explicit;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function ThemeToggle() {
  const [theme, setTheme] = useState(currentTheme);
  const flip = () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('nc-theme', next);
    } catch { /* storage indisponível */ }
    setTheme(next);
  };
  return html`<button className="icon-btn" onClick=${flip} title=${STR.theme} aria-label=${STR.theme}>
    ${theme === 'dark' ? html`<${Icon.sun} />` : html`<${Icon.moon} />`}
  </button>`;
}

// ---- controles ----
function Segmented({ value, onChange, withRelease = false }) {
  const opts = [
    ['all', STR.segAll],
    ['news', STR.segNews],
    ['tool', STR.segTools],
  ];
  if (withRelease) opts.push(['release', STR.segReleases]); // só no browse (a IA julga news|tool)
  return html`<div className="segmented" role="group">
    ${opts.map(
      ([v, label]) => html`<button key=${v} aria-pressed=${value === v} onClick=${() => onChange(v)}>
        ${label}
      </button>`,
    )}
  </div>`;
}

function FacetGroup({ facet, selected, onToggle }) {
  const [expanded, setExpanded] = useState(false);
  const CAP = 14;
  const tags = expanded ? facet.tags : facet.tags.slice(0, CAP);
  const hidden = facet.tags.length - CAP;
  return html`<div className="facet-group">
    <span className="facet-label">${FACET_LABEL[facet.name] || facet.name}</span>
    <div className="chip-row">
      ${tags.map(
        ({ tag, count }) => html`<button
          key=${tag}
          className="chip"
          aria-pressed=${selected.includes(tag)}
          onClick=${() => onToggle(facet.name, tag)}
        >
          ${tag} <span className="count">${count}</span>
        </button>`,
      )}
      ${hidden > 0 &&
      html`<button className="chip chip-more" onClick=${() => setExpanded(!expanded)}>
        ${expanded ? STR.showLess : STR.showMore(hidden)}
      </button>`}
    </div>
  </div>`;
}

// Selo de tipo (ferramenta/release) e de verificação (ok/suspect/junk): release deixou de colapsar
// em news/tool, e o veredito da verificação agora aparece na UI (antes só no inspect/SQL).
function kindBadge(kind) {
  if (kind === 'tool') return html`<span className="tag tool">${STR.toolBadge}</span>`;
  if (kind === 'release') return html`<span className="tag release">${STR.releaseBadge}</span>`;
  return null;
}
const VERIFY_LABEL = { ok: STR.verifyOk, suspect: STR.verifySuspect, junk: STR.verifyJunk };
function verifyBadge(a) {
  const v = a.verify_status;
  if (!v) return null;
  return html`<span
    className=${`tag verify verify-${v}`}
    title=${STR.verifyTitle(v, a.verify_notes)}
  >${VERIFY_LABEL[v] || v}</span>`;
}

function ArticleCard({ a, onOpen }) {
  const title = a.title_pt || a.title || a.url;
  const summary = a.summary_pt || a.snippet || '';
  const chipTags = [...(a.tags['domain'] || []), ...(a.tags['framework-library-tool'] || [])].slice(0, 2);
  return html`<button className="card" onClick=${() => onOpen(a.id)}>
    <span className="eyebrow">
      ${a.source_name || '—'} <span className="dot">·</span> ${bestDate(a)}
    </span>
    <h3>${title}</h3>
    ${summary && html`<p className="summary">${summary}</p>`}
    <span className="card-foot">
      ${a.relation &&
      html`<span className=${`tag relation-${a.relation}`}>
        ${a.relation === 'direct' ? STR.relationDirect : STR.relationSimilar}
      </span>`}
      ${kindBadge(a.kind)}
      ${verifyBadge(a)}
      ${chipTags.map((t) => html`<span key=${t} className="tag">${t}</span>`)}
    </span>
  </button>`;
}

function DetailSheet({ id, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchJSON(`/api/article/${id}`, ac.signal)
      .then(setData)
      .catch((e) => e.name !== 'AbortError' && setError(e.message));
    return () => ac.abort();
  }, [id]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const paragraphs = data
    ? String(data.content || '')
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .slice(0, 200)
    : [];
  const allTags = data ? Object.values(data.tags || {}).flat() : [];

  return html`<div className="overlay" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div className="sheet" role="dialog" aria-modal="true" aria-label=${data ? data.title_pt || data.title : STR.loading}>
      <button className="close" onClick=${onClose} aria-label=${STR.close}>✕</button>
      ${!data && !error && html`<div className="sheet-loading"><span className="spinner" /></div>`}
      ${error && html`<div className="state"><h2>${STR.errorTitle}</h2><p>${error}</p></div>`}
      ${data &&
      html`<${Fragment}>
        <div className="eyebrow">
          ${data.source_name || '—'} · ${bestDate(data)}
          ${data.kind === 'tool' || data.kind === 'release' ? html` · ${kindBadge(data.kind)}` : null}
          ${data.verify_status ? html` · ${verifyBadge(data)}` : null}
        </div>
        <h2>${data.title_pt || data.title || data.url}</h2>
        ${data.title_pt && data.title && data.title_pt !== data.title
          ? html`<div className="eyebrow">${data.title}</div>`
          : null}
        ${allTags.length
          ? html`<div className="tag-cloud">${allTags.map((t) => html`<span key=${t} className="tag">${t}</span>`)}</div>`
          : null}
        ${data.summary_pt && html`<p className="lead">${data.summary_pt}</p>`}
        <hr />
        <div className="content">
          ${paragraphs.map((p, i) => html`<p key=${i}>${p}</p>`)}
        </div>
        <div className="sheet-actions">
          <a className="btn-primary" href=${data.url} target="_blank" rel="noopener noreferrer">
            ${STR.openOriginal} ↗
          </a>
        </div>
      <//>`}
    </div>
  </div>`;
}

// Chips multi-select de fontes: o ESCOPO da busca profunda (mesmo visual .chip do FacetGroup).
function SourceChips({ sources, selected, onToggle }) {
  return html`<div className="facet-group source-chips">
    <span className="facet-label">
      ${STR.sourcesScope}${selected.length ? '' : ` (${STR.allSelected})`}
    </span>
    <div className="chip-row">
      ${sources.map(
        (s) => html`<button
          key=${s.id}
          className="chip"
          aria-pressed=${selected.includes(s.id)}
          onClick=${() => onToggle(s.id)}
        >
          ${s.name} <span className="count">${s.count}</span>
        </button>`,
      )}
    </div>
  </div>`;
}

// Diálogo de confirmação (guard de custo da busca IA): overlay pequeno, Esc/backdrop cancelam.
function ConfirmDialog({ title, body, confirmLabel, onConfirm, onCancel }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return html`<div className="overlay" onClick=${(e) => e.target === e.currentTarget && onCancel()}>
    <div className="dialog" role="dialog" aria-modal="true" aria-label=${title}>
      <h2>${title}</h2>
      <p>${body}</p>
      <div className="dialog-actions">
        <button className="btn-ghost" onClick=${onCancel}>${STR.cancel}</button>
        <button className="btn-primary" onClick=${onConfirm}>${confirmLabel}</button>
      </div>
    </div>
  </div>`;
}

// Modal da key OpenRouter: valida no servidor (probe) e persiste em NC_HOME/.env; a busca
// pendente re-dispara via onSaved. A key só é gravada se o probe passar.
function KeyModal({ onSaved, onClose }) {
  const [key, setKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const save = async () => {
    const k = key.trim();
    if (!k || checking) return;
    setChecking(true);
    setErrMsg('');
    try {
      const r = await postJSON('/api/key', { key: k });
      if (r.ok) return onSaved();
      setErrMsg(r.status === 0 ? STR.keyNetwork : STR.keyInvalid);
    } catch (e) {
      setErrMsg(e.message || STR.keyNetwork);
    } finally {
      setChecking(false);
    }
  };
  return html`<div className="overlay" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div className="dialog" role="dialog" aria-modal="true" aria-label=${STR.keyTitle}>
      <h2>${STR.keyTitle}</h2>
      <p>${STR.keyBody}</p>
      <input
        className="control key-input"
        type="password"
        value=${key}
        placeholder=${STR.keyPlaceholder}
        onInput=${(e) => setKey(e.target.value)}
        onKeyDown=${(e) => e.key === 'Enter' && save()}
        autoFocus
      />
      ${errMsg && html`<p className="key-error">${errMsg}</p>`}
      <div className="dialog-actions">
        <button className="btn-ghost" onClick=${onClose}>${STR.cancel}</button>
        <button className="btn-primary" onClick=${save} disabled=${checking || !key.trim()}>
          ${checking ? STR.keyChecking : STR.keySave}
        </button>
      </div>
    </div>
  </div>`;
}

// ---- app ----
function App() {
  const [meta, setMeta] = useState(null);
  const [metaError, setMetaError] = useState(null);

  const [q, setQ] = useState('');
  const [kind, setKind] = useState('all');
  const [verify, setVerify] = useState('all');
  const [sourceId, setSourceId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [facetSel, setFacetSel] = useState({}); // { faceta: [tags] }
  const [showFacets, setShowFacets] = useState(false);

  // Busca IA: digitar NÃO filtra nada — Enter/botão dispara a IA; `ai` != null é o modo
  // resultados (o grid passa a ser dos itens julgados) até "Limpar resultados".
  const [deep, setDeep] = useState(false);
  const [deepSources, setDeepSources] = useState([]); // ids das fontes do escopo da profunda
  const [ai, setAi] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [confirmInfo, setConfirmInfo] = useState(null); // {count, usd} vindos do preflight
  const [hasKey, setHasKey] = useState(null); // null = ainda não checado
  const [keyOpen, setKeyOpen] = useState(false);

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [detailId, setDetailId] = useState(null);

  const facetKey = JSON.stringify(facetSel);
  const sentinel = useRef(null);
  const abortRef = useRef(null);

  const buildQuery = useCallback(
    (offset) => {
      const sp = new URLSearchParams();
      if (kind !== 'all') sp.set('kind', kind);
      if (verify !== 'all') sp.set('verify', verify);
      if (sourceId) sp.set('source', sourceId);
      if (from) sp.set('from', from);
      if (to) sp.set('to', to);
      if (Object.keys(facetSel).length) sp.set('facets', JSON.stringify(facetSel));
      sp.set('limit', String(PAGE));
      if (offset) sp.set('offset', String(offset));
      return `/api/articles?${sp}`;
    },
    [kind, verify, sourceId, from, to, facetKey],
  );

  const loadMeta = useCallback(() => {
    setMetaError(null);
    fetchJSON('/api/meta')
      .then(setMeta)
      .catch((e) => setMetaError(e.message));
  }, []);
  useEffect(loadMeta, [loadMeta]);

  // A key do LLM existe? (o modal só abre quando o usuário tenta BUSCAR sem key)
  useEffect(() => {
    fetchJSON('/api/key/status')
      .then((r) => setHasKey(Boolean(r.hasKey)))
      .catch(() => setHasKey(null));
  }, []);

  // Recarrega a primeira página a cada mudança de filtro (cancelando a anterior).
  useEffect(() => {
    if (ai || aiLoading) return; // modo resultados IA: o grid é da IA, o browse pausa
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    fetchJSON(buildQuery(0), ac.signal)
      .then((r) => {
        setItems(r.items);
        setTotal(r.total);
        setLoading(false);
      })
      .catch((e) => {
        if (e.name === 'AbortError') return;
        setError(e.message);
        setLoading(false);
      });
    return () => ac.abort();
  }, [buildQuery, ai, aiLoading]);

  const loadMore = useCallback(() => {
    if (ai || aiLoading) return; // a lista IA já vem inteira (sem paginação)
    if (loading || loadingMore || items.length >= total) return;
    setLoadingMore(true);
    fetchJSON(buildQuery(items.length))
      .then((r) => {
        setItems((cur) => [...cur, ...r.items]);
        setTotal(r.total);
        setLoadingMore(false);
      })
      .catch(() => setLoadingMore(false));
  }, [buildQuery, items.length, total, loading, loadingMore, ai, aiLoading]);

  // Scroll infinito: sentinela + IntersectionObserver (o botão continua p/ acessibilidade).
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries[0].isIntersecting && loadMore(), {
      rootMargin: '600px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  // Dispara a busca IA (Enter/botão): preflight de escopo/custo -> confirmação (profunda sempre;
  // soft só acima do limiar) -> POST único (a resposta demora o que a IA demorar; spinner cobre).
  // Função simples (não useCallback): só roda em handler de evento, sempre com estado fresco.
  const doSearch = async (opts = {}) => {
    const query = q.trim();
    if (!query || aiLoading) return;
    setAiError(null);
    if (hasKey === false) {
      setKeyOpen(true); // a "busca pendente" fica nos próprios states (q/deep/escopo)
      return;
    }
    const sources = deep ? deepSources : sourceId ? [Number(sourceId)] : [];
    try {
      if (!opts.confirmed) {
        const sp = new URLSearchParams();
        if (deep) sp.set('deep', '1');
        if (sources.length) sp.set('sources', JSON.stringify(sources));
        if (from) sp.set('from', from);
        if (to) sp.set('to', to);
        const pre = await fetchJSON(`/api/search/scope?${sp}`);
        if (pre.hasKey === false) {
          setHasKey(false);
          setKeyOpen(true);
          return;
        }
        if (pre.count === 0) {
          setAiError(STR.scopeEmpty);
          return;
        }
        if (deep || pre.needsConfirm) {
          setConfirmInfo({ count: pre.count, usd: pre.estimatedUsd });
          return; // o ConfirmDialog re-chama doSearch({confirmed:true})
        }
      }
      setConfirmInfo(null);
      setAiLoading(true);
      const r = await postJSON('/api/search', {
        query,
        deep,
        sources: sources.length ? sources : null,
        from: from || null,
        to: to || null,
        confirm: true,
      });
      setAi(r);
      if (kind === 'release') setKind('all'); // Release não existe no julgamento da IA
    } catch (e) {
      if (e.code === 'NO_KEY') {
        setHasKey(false);
        setKeyOpen(true);
      } else if (e.status === 409) {
        setAiError(STR.busyMsg);
      } else if (e.status === 428) {
        setConfirmInfo({ count: e.data?.count ?? 0, usd: null }); // corrida rara: preflight mudou
      } else {
        setAiError(STR.searchFailed);
      }
    } finally {
      setAiLoading(false);
      loadMeta(); // badge de custo re-sincroniza (a busca pode ter gastado mesmo falhando)
    }
  };

  const clearAi = () => {
    setAi(null);
    setAiError(null);
  };

  const toggleTag = (facet, tag) => {
    setFacetSel((cur) => {
      const list = cur[facet] || [];
      const next = list.includes(tag) ? list.filter((t) => t !== tag) : [...list, tag];
      const out = { ...cur, [facet]: next };
      if (!next.length) delete out[facet];
      return out;
    });
  };

  const activePills = [];
  if (sourceId && meta) {
    const s = meta.sources.find((x) => String(x.id) === String(sourceId));
    if (s) activePills.push({ label: s.name, clear: () => setSourceId('') });
  }
  if (from) activePills.push({ label: `${STR.from.toLowerCase()} ${fmtDate(from)}`, clear: () => setFrom('') });
  if (to) activePills.push({ label: `${STR.to.toLowerCase()} ${fmtDate(to)}`, clear: () => setTo('') });
  if (!ai) {
    // facetas não se aplicam aos resultados IA — pills delas só no browse
    for (const [facet, tags] of Object.entries(facetSel)) {
      for (const tag of tags) activePills.push({ label: tag, clear: () => toggleTag(facet, tag) });
    }
  }
  const nFacetSel = Object.values(facetSel).reduce((n, l) => n + l.length, 0);
  const hasAnyFilter = Boolean(q.trim() || kind !== 'all' || activePills.length);

  const clearAll = () => {
    setQ('');
    setKind('all');
    setSourceId('');
    setFrom('');
    setTo('');
    setFacetSel({});
    setDeep(false);
    setDeepSources([]);
    clearAi();
  };

  // Itens do modo IA filtrados pelo Segmented (paridade com os buckets do CLI: kind do JUIZ).
  const aiItems = ai
    ? ai.items.filter((it) => kind === 'all' || (it.judge_kind || it.kind) === kind)
    : [];

  const dbEmpty = meta && meta.totals.articles === 0;

  return html`<${Fragment}>
    <header className="topbar">
      <div className="container topbar-row">
        <span className="brand">${STR.brand}<span className="muted">${STR.brandSep}</span></span>
        <div className="topbar-right">
          ${meta && meta.cost && meta.cost.totalUsd > 0 &&
          html`<span className="cost-badge" title=${STR.costTitle}>
            💸 US$ ${meta.cost.totalUsd.toFixed(2)}
            <span className="muted"> · ${meta.cost.totalCalls} chamadas</span>
          </span>`}
          <${ThemeToggle} />
        </div>
      </div>
    </header>

    <main className="container">
      <section className="hero">
        <h1>${STR.heroTitle}</h1>
        <p>${STR.heroSub}</p>
        <div className="searchbar">
          <${Icon.search} />
          <input
            type="search"
            value=${q}
            placeholder=${STR.searchPlaceholder}
            onInput=${(e) => setQ(e.target.value)}
            onKeyDown=${(e) => e.key === 'Enter' && doSearch()}
            aria-label=${STR.searchPlaceholder}
            autoFocus
          />
          ${q &&
          html`<button
            className="clear"
            onClick=${() => {
              setQ('');
              clearAi();
            }}
            aria-label=${STR.clear}
          >✕</button>`}
          <button
            className="btn-primary search-btn"
            onClick=${() => doSearch()}
            disabled=${aiLoading || !q.trim()}
          >
            ${STR.searchBtn}
          </button>
        </div>
        <div className="deep-row">
          <label className="deep-toggle">
            <input type="checkbox" checked=${deep} onChange=${(e) => setDeep(e.target.checked)} />
            ${STR.searchDeep}
          </label>
          <span className="muted">${deep ? STR.searchDeepHint : STR.searchHint}</span>
        </div>
        ${deep &&
        meta &&
        html`<${SourceChips}
          sources=${meta.sources}
          selected=${deepSources}
          onToggle=${(id) =>
            setDeepSources((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))}
        />`}
        <${Segmented} value=${kind} onChange=${setKind} withRelease=${!ai} />

        <div className="filterbar">
          <select
            className="control"
            value=${sourceId}
            onChange=${(e) => setSourceId(e.target.value)}
            aria-label=${STR.allSources}
            disabled=${deep}
          >
            <option value="">${STR.allSources}</option>
            ${meta &&
            meta.sources.map(
              (s) => html`<option key=${s.id} value=${s.id}>${s.name} (${s.count})</option>`,
            )}
          </select>
          ${!ai &&
          html`<select
            className="control"
            value=${verify}
            onChange=${(e) => setVerify(e.target.value)}
            aria-label=${STR.verifyAll}
          >
            <option value="all">${STR.verifyAll}</option>
            <option value="ok">✓ ${STR.verifyOk}</option>
            <option value="suspect">⚠ ${STR.verifySuspect}</option>
            <option value="junk">✕ ${STR.verifyJunk}</option>
          </select>`}
          <input
            className="control"
            type="date"
            value=${from}
            max=${to || undefined}
            onChange=${(e) => setFrom(e.target.value)}
            aria-label=${STR.from}
          />
          <input
            className="control"
            type="date"
            value=${to}
            min=${from || undefined}
            onChange=${(e) => setTo(e.target.value)}
            aria-label=${STR.to}
          />
          <button
            className="control"
            data-on=${from === daysAgo(7) && !to}
            onClick=${() => {
              setFrom(daysAgo(7));
              setTo('');
            }}
          >
            ${STR.last7}
          </button>
          <button
            className="control"
            data-on=${from === daysAgo(30) && !to}
            onClick=${() => {
              setFrom(daysAgo(30));
              setTo('');
            }}
          >
            ${STR.last30}
          </button>
          ${!ai && meta && meta.facets.length
            ? html`<button
                className="control"
                data-on=${showFacets || nFacetSel > 0}
                onClick=${() => setShowFacets(!showFacets)}
                aria-expanded=${showFacets}
              >
                ${STR.filters} ${nFacetSel > 0 ? html`<span className="badge">${nFacetSel}</span>` : '▾'}
              </button>`
            : null}
        </div>

        ${!ai &&
        showFacets &&
        meta &&
        html`<div className="facet-panel">
          ${meta.facets.map(
            (f) => html`<${FacetGroup}
              key=${f.name}
              facet=${f}
              selected=${facetSel[f.name] || []}
              onToggle=${toggleTag}
            />`,
          )}
        </div>`}

        ${activePills.length
          ? html`<div className="active-filters">
              ${activePills.map(
                (p, i) => html`<span key=${i} className="pill">
                  ${p.label}
                  <button onClick=${p.clear} aria-label="remover ${p.label}">✕</button>
                </span>`,
              )}
              <button className="link-btn" onClick=${clearAll}>${STR.clearFilters}</button>
            </div>`
          : null}
      </section>

      ${aiLoading &&
      html`<div className="state ai-loading">
        <span className="spinner" />
        <p>${deep ? STR.searchSlowHint : STR.searchSoftHint}</p>
      </div>`}

      ${aiError &&
      html`<div className="results-banner banner-error">
        <span>${aiError}</span>
        <button className="link-btn" onClick=${() => setAiError(null)}>✕</button>
      </div>`}

      ${ai &&
      !aiLoading &&
      html`<div className="results-banner" aria-live="polite">
        <span>
          <strong>${STR.aiResultsFor(ai.query)}</strong>
          <span className="muted">
            ${` · ${STR.aiStats(ai.relevant, ai.total)}`}
            ${ai.truncated ? ` · ${STR.aiTruncated(ai.items.length)}` : ''}
            ${ai.skipped ? ` · ${STR.aiSkipped(ai.skipped)}` : ''}
          </span>
        </span>
        <button className="link-btn" onClick=${clearAi}>${STR.aiClear}</button>
      </div>`}

      ${!ai && !aiLoading
        ? html`<div className="results-meta" aria-live="polite">
            ${loading ? html`<span className="spinner" />` : null}
            ${!loading && !error ? STR.results(total) : null}
          </div>`
        : null}

      ${metaError || error
        ? html`<div className="state">
            <h2>${STR.errorTitle}</h2>
            <p>${metaError || error}</p>
            <button className="btn-ghost" onClick=${() => (metaError ? loadMeta() : setQ(q))}>
              ${STR.retry}
            </button>
          </div>`
        : null}

      ${!ai && !aiLoading && !loading && !error && items.length === 0
        ? html`<div className="state">
            <${Icon.empty} />
            ${dbEmpty && !hasAnyFilter
              ? html`<${Fragment}><h2>${STR.emptyDbTitle}</h2>
                  <p>${STR.emptyDbBody}</p>
                  <p><code>ncrawl crawl</code></p><//>`
              : html`<${Fragment}><h2>${STR.emptyTitle}</h2>
                  <p>${STR.emptyBody}</p>
                  ${hasAnyFilter
                    ? html`<button className="btn-ghost" onClick=${clearAll}>${STR.clearFilters}</button>`
                    : null}<//>`}
          </div>`
        : null}

      ${ai && !aiLoading && aiItems.length === 0
        ? html`<div className="state">
            <${Icon.empty} />
            ${ai.items.length === 0
              ? html`<${Fragment}><h2>${STR.noResults(ai.query)}</h2>
                  <button className="btn-ghost" onClick=${clearAi}>${STR.aiClear}</button><//>`
              : html`<${Fragment}><h2>${STR.emptyTitle}</h2>
                  <button className="btn-ghost" onClick=${() => setKind('all')}>${STR.segAll}</button><//>`}
          </div>`
        : null}

      <div className="grid">
        ${(ai ? aiItems : aiLoading ? [] : items).map(
          (a) => html`<${ArticleCard} key=${a.id} a=${a} onOpen=${setDetailId} />`,
        )}
      </div>

      <div ref=${sentinel}></div>
      ${!ai && !aiLoading && items.length < total && !loading
        ? html`<div className="load-more-wrap">
            <button className="btn-ghost" onClick=${loadMore}>
              ${loadingMore ? html`<span className="spinner" />` : null} ${STR.loadMore}
            </button>
          </div>`
        : null}
    </main>

    ${detailId != null && html`<${DetailSheet} id=${detailId} onClose=${() => setDetailId(null)} />`}
    ${confirmInfo &&
    html`<${ConfirmDialog}
      title=${STR.confirmTitle}
      body=${STR.confirmBody(confirmInfo.count, confirmInfo.usd != null ? confirmInfo.usd.toFixed(2) : '?')}
      confirmLabel=${STR.confirmRun}
      onConfirm=${() => {
        setConfirmInfo(null);
        doSearch({ confirmed: true });
      }}
      onCancel=${() => setConfirmInfo(null)}
    />`}
    ${keyOpen &&
    html`<${KeyModal}
      onSaved=${() => {
        setHasKey(true);
        setKeyOpen(false);
        doSearch();
      }}
      onClose=${() => setKeyOpen(false)}
    />`}
  <//>`;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
