// Logging do backend Vercel (webapp/api/) — fora de src/, não importa o util do CLI.
// A regra do repo ("log via util log/warn/errorLog, nunca console.* direto") vale aqui
// embrulhada: ESTAS funções são os únicos console.* do backend. NUNCA logar segredos
// (chaves, senhas, cookies) — só códigos de erro e contagens.
const TAG = '[nc-admin]';

export function log(...args) {
  console.log(TAG, ...args);
}

export function warn(...args) {
  console.warn(TAG, ...args);
}

export function errorLog(...args) {
  console.error(TAG, ...args);
}
