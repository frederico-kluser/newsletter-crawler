// Toda a CASCA da UI, por idioma (pt/en). O acervo, os resumos e as tags são PT-BR (são
// DADOS, não interface) — por isso não entram aqui. Detecção/troca de idioma: ver i18n.jsx.
// Regra: as duas tabelas têm EXATAMENTE as mesmas chaves (test/i18n.test.js checa paridade).

const pt = {
  brand: 'Acervo',
  tagline: 'newsletters de tecnologia',

  // busca (texto local + IA opcional)
  searchPlaceholder: 'Filtrar por texto…',
  searchAi: 'Buscar com IA (semântica)',
  searchAiShort: 'IA',
  searchClear: 'limpar texto',
  aiNoKeyHint: 'Sem chave você busca por texto e filtros. Adicione uma chave da OpenRouter para a busca inteligente (IA).',
  deepToggle: 'Busca profunda',
  deepHint: 'lê o conteúdo completo de cada artigo do escopo (1 chamada por artigo)',
  softHint: 'julga títulos e resumos em lotes (1 chamada a cada ~40 artigos)',
  strictToggle: 'Estrito',
  strictHint: 'Ligue para ver só as respostas centrais (mais precisas); desligado, inclui também os resultados parecidos.',
  specLabel: 'Entendi sua busca como',
  specHidden: (n) => `+${n} adjacente${n === 1 ? '' : 's'} oculto${n === 1 ? '' : 's'} · desligue “Estrito”`,
  searching: 'buscando…',
  cancel: 'Cancelar',
  // loader da busca IA — progresso nível-ARTIGO (barra + %, X/Y, relevantes, custo, ETA, falhas)
  aiUnitArticles: 'artigos',
  aiUnitRelevant: 'relevante',
  aiUnitRelevants: 'relevantes',
  aiEta: (label) => `~${label} restantes`,
  aiFailed: (n) => `${n} não analisado${n === 1 ? '' : 's'}`,
  aiDeepWarning: 'a busca profunda pode levar alguns minutos',
  aiResults: (relevant, scanned) => `${relevant} relevante${relevant === 1 ? '' : 's'} de ${scanned} analisado${scanned === 1 ? '' : 's'}`,
  aiTruncated: (max) => `resultados limitados aos ${max} melhores`,
  aiCost: (usd) => `custo real: ${usd}`,
  aiCostUnknown: 'custo real: —',
  aiClear: 'Limpar busca',
  aiEmptyScope: 'O escopo atual não tem nenhum artigo — ajuste os filtros.',
  aiError: 'A busca falhou. Verifique sua conexão e tente de novo.',
  aiRetry: 'Tentar de novo',
  aiRelationDirect: 'direto',
  aiRelationSimilar: 'relacionado',
  // retomada da busca (checkpoint no localStorage): reload/fechar-e-reabrir a aba continua de onde parou
  aiResuming: 'retomando busca…',
  aiPaused: 'Busca interrompida — dá pra retomar de onde parou.',
  aiResumeAction: 'Retomar',
  aiResumeDiscard: 'Descartar',

  // histórico de buscas (localStorage; toda busca concluída entra sozinha)
  historyTitle: 'Histórico de buscas',
  historyOpen: 'Histórico de buscas',
  historyEmpty: 'Nenhuma busca salva ainda — toda busca com IA aparece aqui.',
  historyRecent: 'Buscas recentes',
  historyReopen: 'Abrir o resultado salvo (sem custo)',
  historyRerun: 'Rodar de novo',
  historyDelete: 'Apagar',
  historyClear: 'Limpar histórico',
  historyClearConfirm: 'Apagar tudo? Clique de novo.',
  historyFrozen: (when) => `salva em ${when}`,
  historyMissing: (n) => `${n} item${n === 1 ? '' : 's'} fora do acervo`,
  historyStats: (rel, total) => `${rel}/${total}`,

  // confirmação de custo
  confirmTitle: 'Confirmar busca com IA',
  confirmBody: (count, calls) =>
    `O escopo tem ${count} artigo${count === 1 ? '' : 's'} — serão ~${calls} chamada${calls === 1 ? '' : 's'} de IA.`,
  confirmGo: 'Rodar busca',
  confirmCancel: 'Agora não',

  // chave OpenRouter
  keyTitle: 'Chave da OpenRouter',
  keyBody:
    'A busca digitada usa IA e precisa da SUA chave da OpenRouter. Ela fica salva só neste navegador (localStorage) e as chamadas vão direto para a OpenRouter — nada passa por servidor nosso.',
  keyHint: 'Dica: crie uma chave dedicada com limite de crédito em openrouter.ai/keys.',
  keyPlaceholder: 'sk-or-…',
  keySave: 'Validar e salvar',
  keySaving: 'validando…',
  keyInvalid: 'Chave inválida — a OpenRouter recusou. Confira e tente de novo.',
  keyNetwork: 'Não deu para validar (rede). Tente de novo.',
  keyForget: 'Esquecer chave salva',
  keyExpired: 'A chave salva foi recusada pela OpenRouter (expirou ou foi revogada?). Cole outra.',
  keyManageTitle: 'Chave da OpenRouter salva',
  keyManageBody: 'Você já tem uma chave salva neste navegador — a busca com IA está liberada. Cole outra para trocar, ou esqueça a atual.',
  keyBtnHas: 'Chave da OpenRouter salva — gerenciar',
  keyBtnMissing: 'Adicionar chave da OpenRouter (busca com IA)',
  keySaved: 'chave salva ✓',

  // filtros
  filters: 'Filtros',
  filterSource: 'Fonte',
  filterAllSources: 'Todas as fontes',
  filterPeriod: 'Período',
  filterFrom: 'de',
  filterTo: 'até',
  last7: '7 dias',
  last30: '30 dias',
  filterFacets: 'Tags',
  filterVerify: 'Verificação',
  verifyAll: 'Todas',
  facetTagUnavailable: 'Nenhum item com os filtros atuais',
  clearFilters: 'Limpar filtros',
  showMore: (n) => `+${n} mais`,
  showLess: 'mostrar menos',
  activeFilters: 'filtros ativos',

  // grid / cards
  kindLabel: 'Tipo de item',
  results: (n) => `${n} artigo${n === 1 ? '' : 's'}`,
  articleWord: (n) => (n === 1 ? 'artigo' : 'artigos'),
  sourceFallback: (id) => `fonte ${id}`,
  pillSince: (d) => `desde ${d}`,
  pillUntil: (d) => `até ${d}`,
  loadMore: 'Carregar mais',
  emptyBase: 'O acervo está vazio — rode `ncrawl export --format web` para gerar os dados.',
  emptyFiltered: 'Nada por aqui com esses filtros.',
  loadError: 'Não deu para carregar o acervo.',
  retry: 'Recarregar',
  readOriginal: 'Ler o artigo original',
  openArticle: 'Abrir artigo',
  playAll: 'Ouvir resultados',
  stopPlayback: 'Parar áudio',
  playSummary: 'Ouvir resumo',
  close: 'Fechar',
  loading: 'carregando…',
  noSummary: 'sem resumo em português (pendente de processamento)',

  // topbar / tema / idioma / ajuda
  themeToLight: 'Tema claro',
  themeToDark: 'Tema escuro',
  langLabel: 'Idioma',
  langSwitchTo: (name) => `Mudar para ${name}`,
  helpTitle: 'Como funciona',
  costBadgeTitle: 'Custo de IA acumulado da coleta do acervo',
  updatedAt: (d) => `acervo de ${d}`,

  // tutorial (onboarding estilo "Welcome" — passos de alto nível, curtos e opcionais)
  tutorialAria: 'Tour de introdução ao Acervo',
  tutorialStep: (i, n) => `Passo ${i} de ${n}`,
  tutorialSkip: 'Pular',
  tutorialBack: 'Voltar',
  tutorialNext: 'Continuar',
  tutorialDone: 'Começar',
  tutorialGoTo: (i) => `Ir para o passo ${i}`,
  tutorialSteps: [
    {
      icon: 'sparkle',
      title: 'Bem-vindo ao Acervo',
      body: 'Um acervo pesquisável de newsletters de tecnologia. As melhores edições, reunidas, limpas e organizadas — prontas pra explorar.',
    },
    {
      icon: 'search',
      title: 'Busque do seu jeito',
      body: 'Filtre por texto na hora, ou ative a busca por IA (semântica) pra encontrar por ideia, não só por palavra exata. A busca com IA usa a sua própria chave da OpenRouter.',
    },
    {
      icon: 'sliders',
      title: 'Refine com filtros',
      body: 'Combine fonte, período e tags, e alterne entre Notícias, Ferramentas e Releases pra chegar exatamente no que importa.',
    },
    {
      icon: 'cards',
      title: 'Leia sem ruído',
      body: 'Cada card traz um resumo em português. Abra o artigo pra ver o conteúdo limpo e o link direto pra fonte original.',
    },
    {
      icon: 'rocket',
      title: 'Transparente e no seu controle',
      body: 'A busca por IA é BYOK: você vê o custo real de cada consulta e nada passa por servidor nosso. Ajuste tema e idioma quando quiser — é só começar.',
    },
  ],
};

const en = {
  brand: 'Archive',
  tagline: 'tech newsletters',

  searchPlaceholder: 'Filter by text…',
  searchAi: 'Search with AI (semantic)',
  searchAiShort: 'AI',
  searchClear: 'clear text',
  aiNoKeyHint: 'Without a key you can search by text and filters. Add an OpenRouter key for smart (AI) search.',
  deepToggle: 'Deep search',
  deepHint: 'reads the full content of every article in scope (1 call per article)',
  softHint: 'judges titles and summaries in batches (1 call per ~40 articles)',
  strictToggle: 'Strict',
  strictHint: 'Turn on to show only central answers (more precise); off also includes similar results.',
  specLabel: 'I understood your search as',
  specHidden: (n) => `+${n} adjacent hidden · turn off “Strict”`,
  searching: 'searching…',
  cancel: 'Cancel',
  aiUnitArticles: 'articles',
  aiUnitRelevant: 'relevant',
  aiUnitRelevants: 'relevant',
  aiEta: (label) => `~${label} left`,
  aiFailed: (n) => `${n} not analyzed`,
  aiDeepWarning: 'deep search may take a few minutes',
  aiResults: (relevant, scanned) => `${relevant} relevant of ${scanned} analyzed`,
  aiTruncated: (max) => `results limited to the top ${max}`,
  aiCost: (usd) => `real cost: ${usd}`,
  aiCostUnknown: 'real cost: —',
  aiClear: 'Clear search',
  aiEmptyScope: 'The current scope has no articles — adjust the filters.',
  aiError: 'The search failed. Check your connection and try again.',
  aiRetry: 'Try again',
  aiRelationDirect: 'direct',
  aiRelationSimilar: 'related',
  // search resume (localStorage checkpoint): reload / close-and-reopen the tab continues where it left off
  aiResuming: 'resuming search…',
  aiPaused: 'Search interrupted — you can resume where it left off.',
  aiResumeAction: 'Resume',
  aiResumeDiscard: 'Discard',

  // search history (localStorage; every completed search is saved automatically)
  historyTitle: 'Search history',
  historyOpen: 'Search history',
  historyEmpty: 'No saved searches yet — every AI search shows up here.',
  historyRecent: 'Recent searches',
  historyReopen: 'Open the saved result (no cost)',
  historyRerun: 'Run again',
  historyDelete: 'Delete',
  historyClear: 'Clear history',
  historyClearConfirm: 'Delete all? Click again.',
  historyFrozen: (when) => `saved on ${when}`,
  historyMissing: (n) => `${n} item${n === 1 ? '' : 's'} outside the archive`,
  historyStats: (rel, total) => `${rel}/${total}`,

  confirmTitle: 'Confirm AI search',
  confirmBody: (count, calls) =>
    `The scope has ${count} article${count === 1 ? '' : 's'} — that's ~${calls} AI call${calls === 1 ? '' : 's'}.`,
  confirmGo: 'Run search',
  confirmCancel: 'Not now',

  keyTitle: 'OpenRouter key',
  keyBody:
    'Typed search uses AI and needs YOUR OpenRouter key. It is stored only in this browser (localStorage) and calls go straight to OpenRouter — nothing passes through our server.',
  keyHint: 'Tip: create a dedicated key with a credit limit at openrouter.ai/keys.',
  keyPlaceholder: 'sk-or-…',
  keySave: 'Validate and save',
  keySaving: 'validating…',
  keyInvalid: 'Invalid key — OpenRouter rejected it. Check and try again.',
  keyNetwork: 'Could not validate (network). Try again.',
  keyForget: 'Forget saved key',
  keyExpired: 'The saved key was rejected by OpenRouter (expired or revoked?). Paste another.',
  keyManageTitle: 'OpenRouter key saved',
  keyManageBody: 'You already have a key saved in this browser — AI search is enabled. Paste another to replace it, or forget the current one.',
  keyBtnHas: 'OpenRouter key saved — manage',
  keyBtnMissing: 'Add OpenRouter key (AI search)',
  keySaved: 'key saved ✓',

  filters: 'Filters',
  filterSource: 'Source',
  filterAllSources: 'All sources',
  filterPeriod: 'Period',
  filterFrom: 'from',
  filterTo: 'to',
  last7: '7 days',
  last30: '30 days',
  filterFacets: 'Tags',
  filterVerify: 'Verification',
  verifyAll: 'All',
  facetTagUnavailable: 'No items with the current filters',
  clearFilters: 'Clear filters',
  showMore: (n) => `+${n} more`,
  showLess: 'show less',
  activeFilters: 'active filters',

  kindLabel: 'Item type',
  results: (n) => `${n} article${n === 1 ? '' : 's'}`,
  articleWord: (n) => (n === 1 ? 'article' : 'articles'),
  sourceFallback: (id) => `source ${id}`,
  pillSince: (d) => `since ${d}`,
  pillUntil: (d) => `until ${d}`,
  loadMore: 'Load more',
  emptyBase: 'The archive is empty — run `ncrawl export --format web` to generate the data.',
  emptyFiltered: 'Nothing here with these filters.',
  loadError: 'Could not load the archive.',
  retry: 'Reload',
  readOriginal: 'Read the original article',
  openArticle: 'Open article',
  playAll: 'Play results',
  stopPlayback: 'Stop audio',
  playSummary: 'Play summary',
  close: 'Close',
  loading: 'loading…',
  noSummary: 'no Portuguese summary (pending processing)',

  themeToLight: 'Light theme',
  themeToDark: 'Dark theme',
  langLabel: 'Language',
  langSwitchTo: (name) => `Switch to ${name}`,
  helpTitle: 'How it works',
  costBadgeTitle: 'Accumulated AI cost of building the archive',
  updatedAt: (d) => `archive from ${d}`,

  tutorialAria: 'Intro tour of the Archive',
  tutorialStep: (i, n) => `Step ${i} of ${n}`,
  tutorialSkip: 'Skip',
  tutorialBack: 'Back',
  tutorialNext: 'Continue',
  tutorialDone: 'Get started',
  tutorialGoTo: (i) => `Go to step ${i}`,
  tutorialSteps: [
    {
      icon: 'sparkle',
      title: 'Welcome to the Archive',
      body: 'A searchable archive of tech newsletters. The best issues, gathered, cleaned and organized — ready to explore.',
    },
    {
      icon: 'search',
      title: 'Search your way',
      body: 'Filter by text instantly, or turn on AI (semantic) search to find by idea, not just exact words. AI search uses your own OpenRouter key.',
    },
    {
      icon: 'sliders',
      title: 'Refine with filters',
      body: 'Combine source, period and tags, and switch between News, Tools and Releases to land on exactly what matters.',
    },
    {
      icon: 'cards',
      title: 'Read without noise',
      body: 'Each card carries a Portuguese summary. Open an article to see the cleaned content and the direct link to the original source.',
    },
    {
      icon: 'rocket',
      title: 'Transparent and in your control',
      body: 'AI search is BYOK: you see the real cost of every query and nothing passes through our server. Switch theme and language anytime — just get started.',
    },
  ],
};

// Rótulos de vocabulário fixo (kind/verify/faceta), por idioma. Chaves = valores do acervo.
const LABELS = {
  pt: {
    KIND_LABEL: { all: 'Tudo', news: 'Notícias', tool: 'Ferramentas', release: 'Releases' },
    VERIFY_LABEL: { ok: 'ok', suspect: 'suspeito', junk: 'lixo' },
    FACET_LABEL: {
      domain: 'Domínio',
      'content-type': 'Tipo de conteúdo',
      'topic-technology': 'Tecnologia / tópico',
      difficulty: 'Nível',
      'ecosystem-language': 'Ecossistema / linguagem',
      'company-vendor-model': 'Empresa / modelo',
      'framework-library-tool': 'Framework / lib / ferramenta',
      'concept-theme': 'Conceito / tema',
      'trending-emerging': 'Tendências',
    },
  },
  en: {
    KIND_LABEL: { all: 'All', news: 'News', tool: 'Tools', release: 'Releases' },
    VERIFY_LABEL: { ok: 'ok', suspect: 'suspect', junk: 'junk' },
    FACET_LABEL: {
      domain: 'Domain',
      'content-type': 'Content type',
      'topic-technology': 'Technology / topic',
      difficulty: 'Level',
      'ecosystem-language': 'Ecosystem / language',
      'company-vendor-model': 'Company / model',
      'framework-library-tool': 'Framework / lib / tool',
      'concept-theme': 'Concept / theme',
      'trending-emerging': 'Trending',
    },
  },
};

/** Dicionário completo por locale: strings + os três mapas de rótulo, tudo num objeto só. */
export const DICTS = {
  pt: { ...pt, ...LABELS.pt },
  en: { ...en, ...LABELS.en },
};

// Nome de cada idioma no PRÓPRIO idioma (endônimo) — pro toggle e pro aria-label.
export const LOCALE_NAME = { pt: 'Português', en: 'English' };

// Locale ativo dos formatadores de número (setado pelo LocaleProvider em i18n.jsx). Fica num
// singleton de módulo porque fmtUsd/fmtEta são chamados como funções puras, fora do React.
let _fmtLocale = 'pt';
const BCP47 = { pt: 'pt-BR', en: 'en-US' };
export function setFmtLocale(l) {
  _fmtLocale = l === 'en' ? 'en' : 'pt';
}
export function getFmtLocale() {
  return _fmtLocale;
}

/** Formata US$ com 2–4 casas (custos de IA são fracionários), no locale ativo. */
export function fmtUsd(v) {
  const n = Number(v) || 0;
  const digits = n > 0 && n < 0.01 ? 4 : 2;
  return `US$ ${n.toLocaleString(BCP47[_fmtLocale], { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}

/** Inteiro com o separador de milhar do locale ativo (2.370 em pt vs 2,370 em en). */
export function fmtInt(v) {
  return Math.round(Number(v) || 0).toLocaleString(BCP47[_fmtLocale]);
}

/** Data+hora curtas de um ISO (createdAt do histórico), no locale ativo; vazio p/ valor inválido. */
export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(BCP47[_fmtLocale], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** ETA legível a partir de segundos: "45s", "2min", "2min 30s" (unidades neutras). */
export function fmtEta(secs) {
  const s = Math.max(0, Math.round(Number(secs) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}min ${r}s` : `${m}min`;
}
