// Todas as strings da UI (PT-BR) num lugar só — o app é monolíngue de propósito
// (o acervo e os resumos são PT-BR); trocar idioma no futuro = trocar este módulo.

export const STR = {
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
  confirmBody: (count, calls, usd) =>
    `O escopo tem ${count} artigo${count === 1 ? '' : 's'} — serão ~${calls} chamada${calls === 1 ? '' : 's'} de IA (≈ ${usd}).`,
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
  clearFilters: 'Limpar filtros',
  showMore: (n) => `+${n} mais`,
  showLess: 'mostrar menos',
  activeFilters: 'filtros ativos',

  // grid / cards
  results: (n) => `${n} artigo${n === 1 ? '' : 's'}`,
  loadMore: 'Carregar mais',
  emptyBase: 'O acervo está vazio — rode `ncrawl export --format web` para gerar os dados.',
  emptyFiltered: 'Nada por aqui com esses filtros.',
  loadError: 'Não deu para carregar o acervo.',
  retry: 'Recarregar',
  readOriginal: 'Ler o artigo original',
  openArticle: 'Abrir artigo',
  close: 'Fechar',
  loading: 'carregando…',
  noSummary: 'sem resumo em português (pendente de processamento)',

  // topbar / tema
  themeToLight: 'Tema claro',
  themeToDark: 'Tema escuro',
  costBadgeTitle: 'Custo de IA acumulado da coleta do acervo',
  updatedAt: (d) => `acervo de ${d}`,
};

export const KIND_LABEL = {
  all: 'Tudo',
  news: 'Notícias',
  tool: 'Ferramentas',
  release: 'Releases',
};

export const VERIFY_LABEL = {
  ok: 'ok',
  suspect: 'suspeito',
  junk: 'lixo',
};

export const FACET_LABEL = {
  domain: 'Domínio',
  'content-type': 'Tipo de conteúdo',
  'topic-technology': 'Tecnologia / tópico',
  difficulty: 'Nível',
  'ecosystem-language': 'Ecossistema / linguagem',
  'company-vendor-model': 'Empresa / modelo',
  'framework-library-tool': 'Framework / lib / ferramenta',
  'concept-theme': 'Conceito / tema',
  'trending-emerging': 'Tendências',
};

/** Formata US$ com 2–4 casas (custos de IA são fracionários). */
export function fmtUsd(v) {
  const n = Number(v) || 0;
  const digits = n > 0 && n < 0.01 ? 4 : 2;
  return `US$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}

/** Data+hora curtas de um ISO (createdAt do histórico); vazio p/ valor inválido. */
export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** ETA legível a partir de segundos: "45s", "2min", "2min 30s". */
export function fmtEta(secs) {
  const s = Math.max(0, Math.round(Number(secs) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}min ${r}s` : `${m}min`;
}
