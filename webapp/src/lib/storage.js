// localStorage com try/catch: em Safari private/iframe restrito o acesso LANÇA — caímos num
// Map em memória (a sessão funciona; só não persiste entre visitas).
const mem = new Map();

function get(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return mem.get(key) ?? null;
  }
}
function set(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    mem.set(key, value);
  }
}
function del(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    mem.delete(key);
  }
}

export const getTheme = () => get('nc-theme');
export const setTheme = (t) => set('nc-theme', t);

// Chave LLM (BYOK): UM SLOT POR PROVEDOR — nc-or-key (OpenRouter) e nc-ds-key (DeepSeek) — e um
// seletor INDEPENDENTE (nc-llm-provider) que decide QUAL slot a busca IA usa. As duas chaves
// podem ficar salvas ao mesmo tempo; o provedor ativo é o que a busca lê.
// getApiKey() sem argumento devolve a chave do provedor ATIVO — os consumidores existentes
// (useAiSearch) seguem lendo o par (chave, provedor) consistente, sem mudança de contrato.
const keySlot = (provider) => (provider === 'deepseek' ? 'nc-ds-key' : 'nc-or-key');
export const getApiKey = (provider = getProvider()) => get(keySlot(provider));
export const setApiKey = (k, provider = getProvider()) => set(keySlot(provider), k);
export const clearApiKey = (provider = getProvider()) => del(keySlot(provider));

// Provedor LLM ATIVO (BYOK): 'openrouter' (default) | 'deepseek'. Sem valor salvo = openrouter
// (migração silenciosa: usuários antigos só têm chave da OpenRouter e o seletor nem existia).
// O provedor decide qual slot de chave a busca usa; salvar uma chave ATIVA o provedor dela.
export const getProvider = () => (get('nc-llm-provider') === 'deepseek' ? 'deepseek' : 'openrouter');
export const setProvider = (p) => set('nc-llm-provider', p === 'deepseek' ? 'deepseek' : 'openrouter');
export const clearProvider = () => del('nc-llm-provider');

// Histórico de buscas (lido/escrito por lib/history.js). `trySetHistory` distingue QUOTA CHEIA
// (retorna false → o history poda os mais antigos e re-tenta) de storage INDISPONÍVEL (Safari
// private/iframe → cai no Map da sessão e retorna true; sem localStorage, quota é irrelevante).
export const getHistoryRaw = () => get('nc-search-history');
const isQuotaError = (e) =>
  e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
export function trySetHistory(value) {
  try {
    localStorage.setItem('nc-search-history', value);
    return true;
  } catch (e) {
    if (isQuotaError(e)) return false; // deixa o history podar e re-tentar
    mem.set('nc-search-history', value); // localStorage indisponível: mantém na sessão
    return true;
  }
}

// Busca EM ANDAMENTO (checkpoint de "troca rápida", lido/escrito por lib/activeSearch.js). Slot
// ÚNICO, sobrescrito com throttle e LIMPO a cada nova busca — serve p/ RETOMAR após reload/fechar
// a aba. Mesma distinção de quota do history (false → sem retomada, melhor que derrubar a busca).
export const getActiveRaw = () => get('nc-search-active');
export function trySetActive(value) {
  try {
    localStorage.setItem('nc-search-active', value);
    return true;
  } catch (e) {
    if (isQuotaError(e)) return false; // slot muito grande: abre mão da retomada, não da busca
    mem.set('nc-search-active', value); // localStorage indisponível: mantém na sessão
    return true;
  }
}
export const clearActive = () => del('nc-search-active');

export const getLocale = () => get('nc-locale');
export const setLocale = (l) => set('nc-locale', l);

// Rodízio de fontes dentro de cada data (toggle "misturar fontes"). LIGADO por padrão: só o
// desligamento explícito é persistido, então uma visita nova já cai no modo misturado.
export const getMixSources = () => get('nc-mix-sources') !== '0';
export const setMixSources = (on) => set('nc-mix-sources', on ? '1' : '0');

// Tutorial de introdução: mostra sozinho só na 1ª visita; o botão de ajuda reabre sempre.
export const getTutorialSeen = () => get('nc-tutorial-seen') === '1';
export const setTutorialSeen = () => set('nc-tutorial-seen', '1');
