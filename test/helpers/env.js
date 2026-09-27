// AMBIENTE DE TESTE isolado: `sandboxEnv(overrides)` tira um snapshot do process.env, limpa as
// variáveis que decidem provedor/chave/motor (LLM_*, DEEPSEEK_*, OPENROUTER_*, JEV_*, GEMINI_*),
// aponta o NC_HOME para um tmpdir NOVO e aplica os overrides; `restore()` devolve o env EXATO.
//
// Por que um helper e não o boilerplate de sempre (`for k of env: if k.startsWith('LLM_') delete`):
// a migração do Jev troca ~35 suítes de `LLM_PROVIDER=deepseek` para OpenRouter + JEV_ENABLED, e o
// boilerplate copiado à mão esquece sempre uma peça — a mais perigosa é o `.env` do REPO, que o
// config.js carrega com OVERRIDE (`loadDotEnvOverride`): uma OPENROUTER_API_KEY real lá vence a
// variável que o teste setou. A única camada que vence o .env do repo é o NC_HOME/.env (último na
// precedência) — por isso a sandbox SEMEIA um NC_HOME/.env com as chaves neutralizadas (mesmo truque
// do cli-sandbox.js) e com cada override escrito lá também.
//
// ORDEM IMPORTA: chame sandboxEnv() ANTES do primeiro import que alcança src/config.js (direto ou via
// db.js/llm.js/commands.js…). O config lê o env e os .env UMA vez, no load, e exporta a chave como
// binding: uma sandbox montada DEPOIS não desfaz a OPENROUTER_API_KEY real que o módulo já resolveu.
//
// Rede paga: HOJE a proteção é só a chave neutralizada (vazia → HAS_LLM=false; FAKE_OPENROUTER_KEY → 401
// se algo escapar do dublê, nunca gasto). O tripwire do transporte padrão (PAID_NETWORK_BLOCKED quando
// NODE_TEST_CONTEXT/NC_TEST e sem NC_ALLOW_PAID_NETWORK=1, em src/llm.js e src/jev.js) é contrato da W1
// — ainda NÃO existe; até lá, teste sem sandbox (ou com ela montada tarde) usa a chave real do shell.
//
// Sem efeito colateral no import (o `node --test` executa test/helpers/*.js como arquivo de teste):
// só funções e constantes. Nada aqui importa src/.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Prefixos apagados por default: são os que escolhem provedor, chave, modelo e motor (Jev/Gemini).
export const LLM_ENV_PREFIXES = Object.freeze(['LLM_', 'DEEPSEEK_', 'OPENROUTER_', 'JEV_', 'GEMINI_']);

// Chaves que a sandbox APAGA do process.env e ESCREVE (vazias, salvo override) no NC_HOME/.env semeado:
// as de credencial/provedor (o .env do repo pode tê-las), DB_PATH/BACKUP_DIR (um caminho ABSOLUTO no
// shell ou no .env do repo levaria o teste ao crawler.db REAL mesmo com NC_HOME temporário — o config.js
// só resolve contra o NC_HOME quando o valor é relativo) e a escotilha da rede paga (NC_ALLOW_PAID_NETWORK,
// que o tripwire da W1 vai honrar — apagada aqui p/ um teste nunca herdá-la do shell).
export const NEUTRALIZED_KEYS = Object.freeze([
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'LLM_PROVIDER',
  'DB_PATH',
  'BACKUP_DIR',
  'NC_ALLOW_PAID_NETWORK',
]);

// Chave FALSA com cara de OpenRouter: liga HAS_LLM/HAS_JEV sem nunca valer num endpoint real. Use com um
// dublê instalado (jev-double/gemini-double) — sem dublê a chamada iria à rede e voltaria 401 (chave
// inválida: sem gasto); o bloqueio ANTES da rede (tripwire do transporte padrão) chega na W1.
export const FAKE_OPENROUTER_KEY = 'sk-or-test-double-0000';

// O parser do config.js corta a linha no 1º '=' e tira aspas simples/duplas das pontas — valor com
// quebra de linha viraria duas linhas; achata para uma (valor de teste, nunca segredo real).
const envLine = (k, v) => `${k}=${String(v ?? '').replace(/[\r\n]+/g, ' ')}`;

function makeTmpHome(prefix) {
  // realpath: o tmpdir pode ter symlink no caminho, e parte do código compara caminhos por texto.
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Aplica um override: null/undefined APAGA a variável; qualquer outro valor vira string. */
function applyOne(key, value) {
  if (value === null || value === undefined) delete process.env[key];
  else process.env[key] = String(value);
}

/**
 * Cria a sandbox de env. Ordem: snapshot → limpa prefixos/chaves → NC_HOME → NC_TEST=1/NC_UNDER_TEST=1 →
 * overrides. Chame ANTES do 1º import que alcança src/config.js (ver o topo do arquivo).
 *
 * - overrides: { CHAVE: valor } — null/undefined apaga; o resto vira string. Vencem tudo (inclusive o
 *   NC_TEST=1 default e o NC_HOME temporário: `{ NC_HOME: dir }` usa o SEU diretório).
 * - opts.clearPrefixes (default LLM_ENV_PREFIXES) e opts.clear (chaves extras a apagar).
 * - opts.home: true (default) = tmpdir novo, removido no restore(); string = usa esse diretório (não
 *   é removido nem semeado); false = não mexe no NC_HOME.
 * - opts.seedEnvFile (default true): semeia NC_HOME/.env — só no tmpdir que a PRÓPRIA sandbox criou
 *   (nunca sobrescreve um .env preparado pelo teste).
 * - opts.testFlag (default true): NC_TEST=1 — o sinal que o tripwire do transporte padrão do Jev/LLM VAI
 *   ler (W1) p/ barrar a rede paga mesmo fora do `node --test` (rodar `node test/x.test.js` direto não
 *   seta NODE_TEST_CONTEXT) — e NC_UNDER_TEST=1, o que o src/restore.js JÁ lê (isUnderTest): um filho da
 *   CLI lançado de um teste sandboxed não roda o bootstrap de base vazia (~12 s repovoando do git).
 * - opts.keepHome: não apaga o tmpdir no restore() (depuração).
 *
 * Devolve { home, envFile, restore() }. restore() é idempotente e devolve o process.env EXATO do
 * snapshot — inclusive desfazendo o que o config.js carregou do NC_HOME/.env durante o teste.
 */
export function sandboxEnv(overrides = {}, opts = {}) {
  const {
    clearPrefixes = LLM_ENV_PREFIXES,
    clear = [],
    home = true,
    seedEnvFile = true,
    testFlag = true,
    keepHome = false,
    homePrefix = 'nc-env-',
  } = opts;
  const snapshot = { ...process.env };

  for (const k of Object.keys(process.env)) {
    if (clearPrefixes.some((p) => k.startsWith(p))) delete process.env[k];
  }
  for (const k of [...NEUTRALIZED_KEYS, ...clear]) delete process.env[k];

  let createdHome = null;
  const wantsOwnHome = Object.prototype.hasOwnProperty.call(overrides, 'NC_HOME');
  if (!wantsOwnHome && home) {
    const sandboxHome = typeof home === 'string' ? path.resolve(home) : (createdHome = makeTmpHome(homePrefix));
    process.env.NC_HOME = sandboxHome;
  }
  if (testFlag) {
    process.env.NC_TEST = '1';
    process.env.NC_UNDER_TEST = '1';
  }
  for (const [k, v] of Object.entries(overrides)) applyOne(k, v);

  let envFile = null;
  if (createdHome && seedEnvFile) {
    // Chaves neutralizadas SEMPRE presentes (vazias = "sem chave"); cada override com valor também vai
    // para o arquivo, senão o .env do repo (carregado com override) venceria o process.env do teste.
    const lines = new Map(NEUTRALIZED_KEYS.map((k) => [k, process.env[k] ?? '']));
    for (const [k, v] of Object.entries(overrides)) {
      if (k === 'NC_HOME') continue; // NC_HOME/.env não redefine o próprio NC_HOME (já foi lido)
      if (v !== null && v !== undefined) lines.set(k, v);
    }
    envFile = path.join(createdHome, '.env');
    writeFileSync(envFile, `${[...lines].map(([k, v]) => envLine(k, v)).join('\n')}\n`);
  }

  // Rede de limpeza: um teste que esqueça o restore() não deixa tmpdir para trás. O listener é
  // registrado AQUI (na chamada), nunca no import, e sai no restore() — sem acúmulo de listeners.
  const onExit = () => {
    if (createdHome && !keepHome) rmSync(createdHome, { recursive: true, force: true });
  };
  if (createdHome) process.on('exit', onExit);

  let restored = false;
  function restore() {
    if (restored) return;
    restored = true;
    for (const k of Object.keys(process.env)) {
      if (!Object.prototype.hasOwnProperty.call(snapshot, k)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(snapshot)) {
      if (process.env[k] !== v) process.env[k] = v;
    }
    if (createdHome) {
      process.removeListener('exit', onExit);
      if (!keepHome) rmSync(createdHome, { recursive: true, force: true });
    }
  }

  return { home: process.env.NC_HOME ?? null, createdHome, envFile, restore };
}

/** Roda `fn(sandbox)` dentro de uma sandbox e restaura no finally (inclusive se `fn` lançar). */
export async function withSandboxEnv(overrides, fn, opts) {
  const sb = sandboxEnv(overrides, opts);
  try {
    return await fn(sb);
  } finally {
    sb.restore();
  }
}
