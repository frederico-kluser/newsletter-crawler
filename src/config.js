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

// Key com LIVE BINDING (export let): a web UI seta a key em runtime (POST /api/key) e TODOS os
// importadores (llm.js, commands.js, crawl.js, screens.js) enxergam o valor novo sem reiniciar —
// semântica de live bindings do ESM. Não capture em const local ao importar.
export let OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
export let HAS_LLM = Boolean(OPENROUTER_API_KEY);
/** Atualiza a chave em RUNTIME (web UI / `ncrawl key set` no mesmo processo). */
export function setRuntimeKey(key) {
  const k = String(key || '');
  process.env.OPENROUTER_API_KEY = k;
  OPENROUTER_API_KEY = k;
  HAS_LLM = Boolean(k);
}

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

// Overrides finos por estágio: 0/ausente = delega ao governador; setado = teto duro
// (o efetivo vira min(override, lane)). Inteiro > 0, senão 0.
export const envIntOr0 = (k) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
};

export const CONCURRENCY = envIntOr0('CONCURRENCY');
export const PER_HOST_CONCURRENCY = Number(process.env.PER_HOST_CONCURRENCY || 2);
export const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 1000);
export const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
export const MAX_HTML_FOR_LLM = Number(process.env.MAX_HTML_FOR_LLM || 120000);
export const RESPECT_ROBOTS = process.env.CRAWLER_RESPECT_ROBOTS !== 'false';
// Modo agressivo é o DEFAULT (pedido do usuário): ignora robots.txt + identidade de navegador
// real. Desligue por run com --no-aggressive ou globalmente com CRAWLER_AGGRESSIVE=false.
// isBlockedPage e o circuit breaker seguem valendo — agressivo nunca salva página de desafio.
export const AGGRESSIVE_DEFAULT = process.env.CRAWLER_AGGRESSIVE !== 'false';

// ---- pipeline de qualidade por IA (curadoria de roundup, limpeza pré-save, verificação) ----
// Curadoria: a página do agregador é processada por LLM em ITENS estruturados (news/tool/
// release + blurb da própria issue); o item é CADASTRADO já na curadoria e depois enriquecido.
export const CURATE_ROUNDUPS = process.env.CURATE_ROUNDUPS !== 'false';
// Tamanho de cada chunk do markdown da issue enviado a um agente de curadoria (issues maiores
// que isso são divididas e processadas por agentes EM PARALELO na lane llm).
export const CURATE_CHUNK_CHARS = Number(process.env.CURATE_CHUNK_CHARS || 24000);
// Limpeza por IA antes de salvar: remove sujeira de UI (menus/subscribe/rodapé) do conteúdo
// extraído, preservando o texto do artigo. Recorte de custo em CLEAN_MAX_CHARS.
export const CLEAN_BEFORE_SAVE = process.env.CLEAN_BEFORE_SAVE !== 'false';
export const CLEAN_MAX_CHARS = Number(process.env.CLEAN_MAX_CHARS || 20000);
// Verificação pós-cadastro (varredura paralela ao fim do crawl + comando `ncrawl verify`):
// veredito ok|suspect|junk + notas por artigo, persistidos p/ auditoria via `ncrawl inspect`.
export const VERIFY_AFTER_CRAWL = process.env.VERIFY_AFTER_CRAWL !== 'false';
export const VERIFY_MAX_CHARS = Number(process.env.VERIFY_MAX_CHARS || 4000);
export const VERIFY_CONCURRENCY = envIntOr0('VERIFY_CONCURRENCY');
// Verificação em STREAMING: verifica cada ficha logo após salvar/enriquecer (aproveitando a
// folga da lane llm durante o crawl), em vez de só num sweep no fim. O sweep final segue ligado
// como rede de segurança (idempotente, NULL-only) p/ os blurb-only que nunca enriqueceram.
export const VERIFY_STREAMING = process.env.VERIFY_STREAMING !== 'false';
// Streaming de classify/summarize (espelha VERIFY_STREAMING): classifica/resume cada ficha logo
// após salvar/enriquecer, na folga da lane llm, em vez de só no sweep pós-crawl. Os sweeps seguem
// como rede de segurança idempotente (delta-only, needs-*).
export const CLASSIFY_STREAMING = process.env.CLASSIFY_STREAMING !== 'false';
export const SUMMARIZE_STREAMING = process.env.SUMMARIZE_STREAMING !== 'false';

// ---- pool de PROCESSOS de parsing (isola o JSDOM do processo principal) ----
// O parse JSDOM/Readability (causa de um SIGSEGV nativo raro do parser de CSS do JSDOM) sai do
// processo principal p/ um pool de PROCESSOS-filho (child_process/fork): um crash — inclusive um
// SIGSEGV nativo — mata só o filho, o pool respawna e a task resolve p/ um default seguro (o
// chamador degrada). worker_threads NÃO serviam: threads compartilham o processo, um segfault
// derrubava tudo. Também libera paralelismo de CPU real.
export const PARSE_WORKERS =
  envIntOr0('PARSE_WORKERS') || Math.max(1, Math.min(4, os.availableParallelism() - 1));
// Timeout por task de parse: um JSDOM travado não segura um worker p/ sempre (mata e respawna).
export const PARSE_TIMEOUT_MS = Number(process.env.PARSE_TIMEOUT_MS || 30000);
// Timeout de STARTUP do filho: se não mandar o handshake 'ready' nesse prazo (fork ok mas travou
// ao carregar), é descartado e conta como falha de spawn (após MAX_SPAWN_FAILS o pool vai inline).
export const PARSE_READY_TIMEOUT_MS = Number(process.env.PARSE_READY_TIMEOUT_MS || 10000);
// =false força o caminho INLINE (parse no processo principal, comportamento antigo) — útil em
// ambientes sem child_process/IPC ou p/ depurar. O pool também cai p/ inline sozinho se não subir.
export const PARSE_IN_WORKERS = process.env.PARSE_IN_WORKERS !== 'false';

// ---- deadline por job (o retardatário não segura o fim da execução) ----
// Orçamento de TRABALHO por job de artigo (0 = sem deadline): conta só as fases fetch/render/
// parse (createJobClock); esperas de fila (lanes, politeness por host) e as fases LLM ficam com
// o relógio PARADO — elas têm timeouts/orçamento próprios. Estourou: o job é ABORTADO de verdade
// (AbortSignal — sem zumbi segurando lane); item curado mantém o blurb (needs_enrich=1) e é
// re-enfileirado p/ enriquecer num próximo crawl; nada se perde.
export const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 90000);
// Teto DURO de tempo de PAREDE por job de artigo (rede de segurança p/ fase não instrumentada
// ou espera patológica). 0 desliga; default 10x o orçamento de trabalho.
export const JOB_HARD_TIMEOUT_MS = Number(
  process.env.JOB_HARD_TIMEOUT_MS || (JOB_TIMEOUT_MS > 0 ? JOB_TIMEOUT_MS * 10 : 0),
);
// Curadoria (listing/roundup) tem POOL de reivindicação próprio: a fase de LLM (por seção +
// cobertura) é longa e NÃO deve ocupar a capacidade de fetch/render dos artigos. CURATE_JOBS=0
// => default calculado em commands.js (max(2, ceil(MAX_PARALLEL/4))). Sem deadline duro por
// default (a curadoria já é limitada por LLM_TIMEOUT_MS/orçamento; cortar no meio joga fora fan-out).
export const CURATE_JOBS = envIntOr0('CURATE_JOBS');
export const ROUNDUP_TIMEOUT_MS = Number(process.env.ROUNDUP_TIMEOUT_MS || 0);

// ---- paralelismo global + orçamento (governor/budget) ----
// Teto GLOBAL de operações simultâneas (--parallel). Deriva dos núcleos como proxy do porte
// da máquina (o trabalho é I/O-bound, não CPU-bound); clamp p/ ser útil de VPS a workstation.
export function defaultParallel() {
  return Math.min(64, Math.max(4, os.availableParallelism()));
}
export const MAX_PARALLEL = envIntOr0('MAX_PARALLEL') || defaultParallel();
// Orçamento por execução em USD (0 = ilimitado). O ledger grava o custo real SEMPRE.
export const BUDGET_USD = Number(process.env.BUDGET_USD || 0);
// Custo AO VIVO no CLI (npm run crawl): intervalo entre linhas de "gasto parcial" (lê o mesmo
// snapshot em memória da TUI). Na TUI o painel já mostra ao vivo; isto cobre o CLI puro.
export const COST_LOG_INTERVAL_MS = Number(process.env.COST_LOG_INTERVAL_MS || 10000);
// Teto de uso de RAM DO SISTEMA: o governador mantém MemAvailable >= max(total*(1-pct/100), 2 GiB).
// É a RAM da máquina inteira (desktop incluso), não o RSS do processo — Chromium é filho externo.
export const RAM_MAX_PCT = Number(process.env.RAM_MAX_PCT || 80);
export const RAM_HYSTERESIS_PCT = Number(process.env.RAM_HYSTERESIS_PCT || 10);
export const GOVERNOR_TICK_MS = Number(process.env.GOVERNOR_TICK_MS || 1000);
// Estimativa de RAM de um render Chromium (contexto+página) p/ o ramp da lane render.
export const RENDER_EST_MB = Number(process.env.RENDER_EST_MB || 300);
// Timeout por chamada LLM. O default do SDK seria 10 min E re-tentado — em paralelismo alto,
// um lote pendurado seguraria slots por até 40 min e cegaria o governador.
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 180000);

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
// Scroll infinito (perfil listing): nº de checagens CONSECUTIVAS sem nenhum link novo no DOM
// p/ declarar o feed estagnado e parar de rolar (a parada por data --since e o teto de rodadas
// continuam valendo). Evita gastar sempre as 60 rodadas/90s num feed que não cresce mais.
export const SCROLL_STALL_CHECKS = Number(process.env.SCROLL_STALL_CHECKS || 3);
// Rolagem (perfil listing): passo em px por rodada e TETO da espera adaptativa por conteúdo novo.
// O settle sai cedo assim que a página cresce (feed rápido) e é paciente até SCROLL_SETTLE_MAX_MS
// (feed lento) — no lugar do antigo pause fixo de 800ms, que truncava feed lento e desperdiçava
// tempo em feed rápido.
export const SCROLL_STEP = Number(process.env.SCROLL_STEP || 1200);
export const SCROLL_SETTLE_MAX_MS = Number(process.env.SCROLL_SETTLE_MAX_MS || 2500);
// Perfis de render (antes hard-coded em RENDER_PROFILES/fetch.js): nº máx de rodadas de scroll e
// deadline de parede (ms) por perfil, e máx de cliques em "carregar mais" por página (listing).
export const SCROLL_ROUNDS = Number(process.env.SCROLL_ROUNDS || 60);
export const SCROLL_ROUNDS_ARTICLE = Number(process.env.SCROLL_ROUNDS_ARTICLE || 8);
export const RENDER_LISTING_DEADLINE_MS = Number(process.env.RENDER_LISTING_DEADLINE_MS || 90000);
export const RENDER_ARTICLE_DEADLINE_MS = Number(process.env.RENDER_ARTICLE_DEADLINE_MS || 30000);
export const MAX_LOAD_MORE = Number(process.env.MAX_LOAD_MORE || 50);

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
  'searchBatch', // busca soft da web: julga um LOTE de ~40 artigos vs consulta (Flash)
  'searchTags', // busca modo B: mapeia consulta -> tags por faceta (Pro)
  'searchSpec', // busca precisão-primeiro: "entende" a consulta -> spec (Pro high, 1x por busca)
  'curate', // curadoria da issue: itens estruturados news/tool/release (Flash, chunks paralelos)
  'articleClean', // limpeza pré-save do conteúdo extraído (Flash)
  'verifyRecord', // verificação pós-cadastro: veredito ok|suspect|junk (Flash)
  'dateSelector', // seletor de DATA da listagem (CSS + regex) lendo a página real (Flash)
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

/**
 * Modelo por FACETA da classificação (o estágio mais caro): models.json pode ter uma chave
 * "classify:<faceta>" (ou env LLM_MODEL_CLASSIFY_<FACETA>) p/ escolher o modelo por faceta. Só as
 * facetas CORE (domain, topic-technology) herdam a etapa base 'classify' (Pro/high); as outras 7 têm
 * override Flash/medium (classificação = tarefa de vocabulário fixo, small-output → Flash basta).
 */
export function classifyFacetModel(facetName) {
  const fileStage = _modelsCfg.stages && _modelsCfg.stages[`classify:${facetName}`];
  const ek = `CLASSIFY_${String(facetName).replace(/[^a-z0-9]+/gi, '_').toUpperCase()}`;
  const model = process.env[`LLM_MODEL_${ek}`] || (fileStage && fileStage.model);
  let effort = process.env[`LLM_EFFORT_${ek}`] || (fileStage && fileStage.effort);
  if (!model && !effort) return stageModel('classify'); // sem override: etapa base
  const base = stageModel('classify');
  effort = effort || base.effort;
  if (effort === 'max') effort = 'xhigh'; // DeepSeek V4 rejeita "max"
  return { model: model || base.model, effort };
}

// ---- classificação multi-faceta (pós-processamento) ----
// Aliases legados da etapa classify (usados por classify.js para logar/persistir model_used).
export const CLASSIFY_MODEL = STAGE_MODELS.classify.model;
export const CLASSIFY_EFFORT = STAGE_MODELS.classify.effort;
// Teto fino de chamadas de faceta simultâneas (0 = a lane llm do governador decide).
export const CLASSIFY_CONCURRENCY = envIntOr0('CLASSIFY_CONCURRENCY');
// Janela de artigos processados ao mesmo tempo (cada um abre N facetas na lane llm).
export const ARTICLE_CONCURRENCY = envIntOr0('ARTICLE_CONCURRENCY');
// Recorte do corpo do artigo enviado a CADA agente (controle de custo de tokens). Título + início
// do corpo já bastam p/ atribuir tags do vocabulário fixo; corpo inteiro só inflava o custo.
export const CLASSIFY_MAX_CHARS = Number(process.env.CLASSIFY_MAX_CHARS || 2000);
// Hook pós-crawl: classifica os novos artigos ao fim do `crawl` (desligue com =false ou --no-classify).
export const CLASSIFY_AFTER_CRAWL = process.env.CLASSIFY_AFTER_CRAWL !== 'false';

// ---- resumos PT-BR (pós-processamento) ----
// 1 chamada/artigo (Flash high): título + resumo em português do Brasil. `content` segue original.
export const SUMMARIZE_CONCURRENCY = envIntOr0('SUMMARIZE_CONCURRENCY');
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
export const SEARCH_FLASH_CONCURRENCY = envIntOr0('SEARCH_FLASH_CONCURRENCY');
// Recorte do corpo enviado por artigo no modo A (controle de custo a 50x).
export const SEARCH_MAX_CHARS = Number(process.env.SEARCH_MAX_CHARS || 8000);
// Guard de custo: acima disto de artigos, o modo A exige --yes (evita varredura cara acidental).
export const SEARCH_MODE_A_CONFIRM = Number(process.env.SEARCH_MODE_A_CONFIRM || 200);

// ---- busca IA da web UI (soft em lote / hard por artigo) ----
// Soft: 1 chamada Flash julga um LOTE de artigos (título+resumo) de uma vez.
export const SEARCH_BATCH_SIZE = Number(process.env.SEARCH_BATCH_SIZE || 40);
// Lotes simultâneos (0 = a lane llm do governador decide).
export const SEARCH_BATCH_CONCURRENCY = envIntOr0('SEARCH_BATCH_CONCURRENCY');
// Guard da soft (barata: ~n/40 chamadas): só exige confirmação em escopos muito grandes.
export const SEARCH_SOFT_CONFIRM = Number(process.env.SEARCH_SOFT_CONFIRM || 4000);
// Teto de itens devolvidos ao navegador numa busca IA (os contadores seguem com o total real).
export const SEARCH_WEB_MAX_ITEMS = Number(process.env.SEARCH_WEB_MAX_ITEMS || 500);
// Pré-filtro LÉXICO (FTS5/BM25): quando o escopo é MAIOR que isto, o LLM julga só o top-K candidato
// (por BM25) em vez do acervo inteiro — corta o custo O(n) e afia a precisão. Escopo <= K = julga
// tudo (recall pleno). Generoso de propósito: recall léxico até a metade densa (embeddings) entrar.
export const SEARCH_CANDIDATES_K = Number(process.env.SEARCH_CANDIDATES_K || 200);

// ---- embeddings locais + busca vetorial (metade DENSA do retrieval híbrido) ----
// Modelo de embedding (transformers.js/onnxruntime, baixado 1x p/ NC_HOME/models). bge-small-en =
// 384 dims, normalizado. RRF_K = constante da fusão Reciprocal Rank Fusion (léxico ⊕ denso).
export const EMBED_MODEL = process.env.EMBED_MODEL || 'Xenova/bge-small-en-v1.5';
export const EMBED_DIM = Number(process.env.EMBED_DIM || 384);
export const EMBED_BATCH = Number(process.env.EMBED_BATCH || 64);
export const RRF_K = Number(process.env.RRF_K || 60);
// Rerank cross-encoder (precisão): reordena o TOPO dos candidatos RRF antes do LLM. Reranqueia só
// o top RERANK_POOL (limita latência) e mantém RERANK_KEEP. Fail-open: modelo ausente => mantém RRF.
export const RERANK_MODEL = process.env.RERANK_MODEL || 'Xenova/bge-reranker-base';
export const RERANK_ENABLED = process.env.RERANK_ENABLED !== 'false';
export const RERANK_POOL = Number(process.env.RERANK_POOL || 128);
export const RERANK_KEEP = Number(process.env.RERANK_KEEP || RERANK_POOL);
// Concorrência INICIAL (teto) da lane AIMD do WEBAPP estático (browser BYOK): a lane começa aqui
// e corta ½ no 429 / recupera +1/10s sozinha (lane.js). O CLI/servidor usam o governor; isto vai
// no meta.search do snapshot só p/ o webapp (com defaults embutidos se o export for antigo).
export const SEARCH_WEB_SOFT_CONCURRENCY = Number(process.env.SEARCH_WEB_SOFT_CONCURRENCY || 6);
export const SEARCH_WEB_DEEP_CONCURRENCY = Number(process.env.SEARCH_WEB_DEEP_CONCURRENCY || 10);
// Paralelismo ESCOLHIDO pelo usuário na UI da busca (slider): teto do pool por busca. O governor
// (lane llm) segue por baixo com AIMD (429 → ½), então este é só o TETO. default = ponto de partida
// do slider; ceiling = máximo que o slider oferece (OpenRouter não tem cap de plataforma em modelo
// pago — o teto só evita thrash de 429). O servidor CLAMPA a [1, ceiling] o valor recebido.
export const SEARCH_UI_CONCURRENCY_DEFAULT = Number(process.env.SEARCH_UI_CONCURRENCY_DEFAULT || 8);
export const SEARCH_UI_CONCURRENCY_CEILING = Number(process.env.SEARCH_UI_CONCURRENCY_CEILING || 24);

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
