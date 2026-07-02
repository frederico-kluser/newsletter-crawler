// Configuração central: carrega .env, sources e constantes.
import { readFileSync, existsSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { normalizeUrl } from './util.js'; // util é puro (não importa config) -> sem ciclo

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- diretório "casa" do usuário (dados previsíveis ao rodar o `ncrawl` global) ----
// Tudo que é RUNTIME/segredo do USUÁRIO (banco SQLite, .env, sources.json, exports) mora aqui —
// NÃO dentro do repo. Assim o binário linkado (`npm link`) funciona de QUALQUER diretório e os
// dados ficam num lugar previsível. Override por env `NC_HOME`. O config do APP versionado
// (config/models.json, config/taxonomy.json e o sources.json semente) continua em ROOT/config.
export const NC_HOME = process.env.NC_HOME
  ? path.resolve(process.env.NC_HOME)
  : path.join(os.homedir(), '.newsletter-crawler');
mkdirSync(NC_HOME, { recursive: true });

// .env do usuário/global (destino do `ncrawl key set`). Precedência final sobre o .env do repo.
export const ENV_PATH = path.join(NC_HOME, '.env');

/** Copia `src` -> `dest` só se `dest` ainda não existe (semeia o arquivo do usuário 1x, não-destrutivo). */
function seedFile(dest, src) {
  try {
    if (!existsSync(dest) && existsSync(src)) copyFileSync(src, dest);
  } catch {
    /* semeadura é best-effort: se falhar, os loaders caem no default do repo */
  }
}

// Carrega o .env do projeto e faz OVERRIDE de variáveis herdadas do shell.
// (Tanto `node --env-file` quanto process.loadEnvFile NÃO sobrescrevem variáveis
//  que já existem no ambiente; aqui o .env do projeto tem precedência, para honrar
//  a chave que o usuário salvou — evitando que uma OPENROUTER_API_KEY antiga no
//  perfil do shell "sombreie" a correta.)
function loadDotEnvOverride(file) {
  if (!existsSync(file)) return;
  let txt = '';
  try {
    txt = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) process.env[key] = val;
  }
}
// Precedência (o último a rodar vence): env do shell < .env do repo (dev) < NC_HOME/.env (usuário).
// Mantém a regra "o .env do projeto sobrescreve variáveis herdadas do shell" E ainda deixa a chave
// salva pelo `ncrawl key set` (em NC_HOME/.env) ter a palavra final quando se roda global.
loadDotEnvOverride(path.join(ROOT, '.env'));
loadDotEnvOverride(ENV_PATH);

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
export const HAS_LLM = Boolean(OPENROUTER_API_KEY);

export const MODELS = {
  pro: process.env.LLM_PRO_MODEL || 'deepseek/deepseek-v4-pro',
  flash: process.env.LLM_FLASH_MODEL || 'deepseek/deepseek-v4-flash',
};

export const USER_AGENT =
  process.env.CRAWLER_UA ||
  'NewsletterArchiver/1.0 (+https://example.com/bot; contato: you@example.com)';

export const HTTP_REFERER = process.env.OPENROUTER_REFERER || 'https://example.com';
export const X_TITLE = 'NewsletterArchiver';

// Banco em NC_HOME (previsível/global). `DB_PATH` relativo resolve contra NC_HOME; absoluto vale como é.
export const DB_PATH = process.env.DB_PATH
  ? path.resolve(NC_HOME, process.env.DB_PATH)
  : path.join(NC_HOME, 'crawler.db');

// Destino dos exports (`ncrawl export`). Também em NC_HOME, longe do repo.
export const EXPORT_DIR = path.join(NC_HOME, 'export');

export const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
export const PER_HOST_CONCURRENCY = Number(process.env.PER_HOST_CONCURRENCY || 2);
export const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 1000);
export const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
export const MAX_HTML_FOR_LLM = Number(process.env.MAX_HTML_FOR_LLM || 120000);
export const RESPECT_ROBOTS = process.env.CRAWLER_RESPECT_ROBOTS !== 'false';

// ---- crawl multinível (índice -> roundup/issue -> artigo) ----
// Profundidade máxima da recursão (índice=0, issue=1, artigo=2, roundup-do-artigo=3...).
// Trava de segurança contra recursão infinita em páginas que parecem coleções.
export const MAX_CRAWL_DEPTH = Number(process.env.MAX_CRAWL_DEPTH || 3);
// Nº mínimo de links externos no corpo (Readability) p/ considerar uma issue/roundup válida.
export const ROUNDUP_MIN_LINKS = Number(process.env.ROUNDUP_MIN_LINKS || 3);
// Reclassificar um ARTIGO como roundup (dividir em N) exige TRÊS sinais juntos, pois o nº de
// links sozinho é fraco: um paper científico tem dezenas/centenas de referências e NÃO é um
// roundup. Só dividimos quando a página é PREDOMINANTEMENTE uma lista de links (pouca prosa)
// e o nº de links externos está numa faixa "de roundup" (nem poucos, nem um link-farm).
export const ARTICLE_ROUNDUP_MIN_LINKS = Number(process.env.ARTICLE_ROUNDUP_MIN_LINKS || 10);
export const ARTICLE_ROUNDUP_MAX_LINKS = Number(process.env.ARTICLE_ROUNDUP_MAX_LINKS || 60);
// Acima disto de prosa (chars do corpo Readability) a página é um ARTIGO, não uma lista.
export const ROUNDUP_MAX_PROSE_CHARS = Number(process.env.ROUNDUP_MAX_PROSE_CHARS || 1500);
// Teto de segurança da paginação do índice quando `--since` está ativo (a parada por data
// deve disparar antes; isto evita varrer um arquivo gigante se as datas faltarem/falharem).
export const SINCE_MAX_INDEX_PAGES = Number(process.env.SINCE_MAX_INDEX_PAGES || 60);

// ---- modelos por etapa do pipeline (config/models.json + override por env) ----
// Default de TODAS as etapas: deepseek/deepseek-v4-pro + xhigh ("ultrathink"). Para o
// DeepSeek V4, "max" é rejeitado com HTTP 400 — por isso o teto real é "xhigh" (guard abaixo).
export const STAGE_KEYS = [
  'linkSelector', // deriva o seletor CSS dos links da listagem
  'linkExtract', // fallback: extrai links item-a-item
  'roundupExtract', // fallback: extrai links externos curados de uma issue/roundup
  'nextLink', // deriva o link da próxima página (paginação)
  'contentSelector', // deriva o seletor CSS do corpo do artigo
  'articleExtract', // fallback: extrai título/corpo/data do artigo
  'classify', // classificação multi-faceta de tags
  'summarize', // resumo + título em PT-BR (Flash high)
  'searchRelevance', // busca modo A: julga artigo vs consulta (Flash high, 50x)
  'searchTags', // busca modo B: mapeia consulta -> tags por faceta (Pro)
];
const DEFAULT_MODEL = MODELS.pro;
const DEFAULT_EFFORT = 'xhigh';

function loadModelsConfig() {
  const p = path.join(ROOT, 'config', 'models.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}
// linkSelector -> LINK_SELECTOR (sufixo das chaves de env)
const envKeyOf = (stage) => stage.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase();

function resolveStage(stage, cfg) {
  const fileDef = cfg.default || {};
  const fileStage = (cfg.stages && cfg.stages[stage]) || {};
  const ek = envKeyOf(stage);
  // Precedência: env específico > arquivo(etapa) > env default > arquivo(default) > hardcoded.
  // CLASSIFY_MODEL/CLASSIFY_EFFORT seguem aceitos como alias legado da etapa classify.
  const model =
    process.env[`LLM_MODEL_${ek}`] ||
    (stage === 'classify' ? process.env.CLASSIFY_MODEL : '') ||
    fileStage.model ||
    process.env.LLM_DEFAULT_MODEL ||
    fileDef.model ||
    DEFAULT_MODEL;
  let effort =
    process.env[`LLM_EFFORT_${ek}`] ||
    (stage === 'classify' ? process.env.CLASSIFY_EFFORT : '') ||
    fileStage.effort ||
    process.env.LLM_DEFAULT_EFFORT ||
    fileDef.effort ||
    DEFAULT_EFFORT;
  if (effort === 'max') effort = 'xhigh'; // DeepSeek V4 rejeita "max" (400); callJSON também protege
  return { model, effort };
}

const _modelsCfg = loadModelsConfig();
export const STAGE_MODELS = Object.fromEntries(STAGE_KEYS.map((s) => [s, resolveStage(s, _modelsCfg)]));

/** {model, effort} resolvido para uma etapa do pipeline (default: Pro + xhigh). */
export function stageModel(stage) {
  return STAGE_MODELS[stage] || { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT };
}

// ---- classificação multi-faceta (pós-processamento) ----
// Aliases legados da etapa classify (usados por classify.js para logar/persistir model_used).
export const CLASSIFY_MODEL = STAGE_MODELS.classify.model;
export const CLASSIFY_EFFORT = STAGE_MODELS.classify.effort;
// Gate GLOBAL de chamadas de faceta (limita o total simultâneo na OpenRouter).
export const CLASSIFY_CONCURRENCY = Number(process.env.CLASSIFY_CONCURRENCY || 6);
// Janela de artigos processados ao mesmo tempo (cada um abre N facetas no gate global).
export const ARTICLE_CONCURRENCY = Number(process.env.ARTICLE_CONCURRENCY || 2);
// Recorte do corpo do artigo enviado a CADA agente (controle de custo de tokens).
export const CLASSIFY_MAX_CHARS = Number(process.env.CLASSIFY_MAX_CHARS || 12000);
// Hook pós-crawl: classifica os novos artigos ao fim do `crawl` (desligue com =false ou --no-classify).
export const CLASSIFY_AFTER_CRAWL = process.env.CLASSIFY_AFTER_CRAWL !== 'false';

// ---- resumos PT-BR (pós-processamento) ----
// 1 chamada/artigo (Flash high): título + resumo em português do Brasil. `content` segue original.
export const SUMMARIZE_CONCURRENCY = Number(process.env.SUMMARIZE_CONCURRENCY || 6);
export const SUMMARIZE_MAX_CHARS = Number(process.env.SUMMARIZE_MAX_CHARS || 12000);
// Hook pós-crawl: gera os resumos ao fim do crawl (desligue com =false ou --no-summarize).
export const SUMMARIZE_AFTER_CRAWL = process.env.SUMMARIZE_AFTER_CRAWL !== 'false';

// ---- buscador web (`ncrawl web`) ----
// Servidor local do buscador React (zero-build). Só escuta em loopback por padrão: a base é
// pessoal e a API não tem auth — exponha em rede consciente via NC_WEB_HOST.
export const WEB_PORT = Number(process.env.NC_WEB_PORT || 8477);
export const WEB_HOST = process.env.NC_WEB_HOST || '127.0.0.1';

// ---- busca na base ----
// Modo A (exaustivo): 50 chamadas Flash simultâneas julgando CADA artigo vs a consulta.
export const SEARCH_FLASH_CONCURRENCY = Number(process.env.SEARCH_FLASH_CONCURRENCY || 50);
// Recorte do corpo enviado por artigo no modo A (controle de custo a 50x).
export const SEARCH_MAX_CHARS = Number(process.env.SEARCH_MAX_CHARS || 8000);
// Guard de custo: acima disto de artigos, o modo A exige --yes (evita varredura cara acidental).
export const SEARCH_MODE_A_CONFIRM = Number(process.env.SEARCH_MODE_A_CONFIRM || 200);

// sources.json do USUÁRIO mora em NC_HOME (o `ncrawl add`/assistente grava aqui). É semeado 1x a
// partir do default versionado do repo, para não perder as fontes que já vêm no projeto.
export const DEFAULT_SOURCES_PATH = path.join(ROOT, 'config', 'sources.json');
export const SOURCES_PATH = path.join(NC_HOME, 'sources.json');
seedFile(SOURCES_PATH, DEFAULT_SOURCES_PATH);

export function loadSources() {
  try {
    const raw = JSON.parse(readFileSync(SOURCES_PATH, 'utf8'));
    return Array.isArray(raw.sources) ? raw.sources : [];
  } catch {
    return [];
  }
}

/**
 * Persiste (upsert por URL normalizada) uma fonte no sources.json do usuário (NC_HOME por
 * default), para ela ficar PERMANENTE: aparece no seletor da UI e é re-semeada a cada crawl.
 * `configPath` é injetável p/ teste. Retorna { added, total }.
 */
export function addSourceToConfig({ url, name, type, maxIndexPages }, configPath = SOURCES_PATH) {
  let data = { sources: [] };
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    if (raw && Array.isArray(raw.sources)) data = raw;
  } catch {
    /* arquivo ausente/ inválido: começa do zero */
  }
  const entry = {};
  if (name) entry.name = name;
  entry.url = url;
  if (type) entry.type = type;
  if (maxIndexPages != null) entry.maxIndexPages = Number(maxIndexPages);

  const key = normalizeUrl(url);
  const i = data.sources.findIndex((s) => normalizeUrl(s.url) === key);
  if (i >= 0) data.sources[i] = { ...data.sources[i], ...entry };
  else data.sources.push(entry);
  writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n');
  return { added: i < 0, total: data.sources.length };
}

// Vocabulário controlado da classificação. Lança se ausente/ inválido (a classificação
// EXIGE o vocabulário); chamado de forma preguiçosa por taxonomy.js para não quebrar
// `npm run status`, que importa o módulo mas não classifica.
export function loadTaxonomy() {
  const p = path.join(ROOT, 'config', 'taxonomy.json');
  return JSON.parse(readFileSync(p, 'utf8'));
}
