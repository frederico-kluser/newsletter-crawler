// Configuração central: carrega .env, sources e constantes.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
loadDotEnvOverride(path.join(ROOT, '.env'));

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

export const DB_PATH = process.env.DB_PATH
  ? path.resolve(ROOT, process.env.DB_PATH)
  : path.join(ROOT, 'data', 'crawler.db');

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

export function loadSources() {
  const p = path.join(ROOT, 'config', 'sources.json');
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(raw.sources) ? raw.sources : [];
  } catch {
    return [];
  }
}

// Vocabulário controlado da classificação. Lança se ausente/ inválido (a classificação
// EXIGE o vocabulário); chamado de forma preguiçosa por taxonomy.js para não quebrar
// `npm run status`, que importa o módulo mas não classifica.
export function loadTaxonomy() {
  const p = path.join(ROOT, 'config', 'taxonomy.json');
  return JSON.parse(readFileSync(p, 'utf8'));
}
