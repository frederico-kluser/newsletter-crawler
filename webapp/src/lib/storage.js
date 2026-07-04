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

export const getApiKey = () => get('nc-or-key');
export const setApiKey = (k) => set('nc-or-key', k);
export const clearApiKey = () => del('nc-or-key');

export const getLocale = () => get('nc-locale');
export const setLocale = (l) => set('nc-locale', l);

// Tutorial de introdução: mostra sozinho só na 1ª visita; o botão de ajuda reabre sempre.
export const getTutorialSeen = () => get('nc-tutorial-seen') === '1';
export const setTutorialSeen = () => set('nc-tutorial-seen', '1');
