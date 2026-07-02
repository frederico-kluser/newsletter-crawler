// Persistência SQLite (better-sqlite3): schema + prepared statements.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DB_PATH } from './config.js';
import { foldText, parseDate } from './util.js';

mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Dois processos `ncrawl` podem compartilhar este DB (ex.: crawl + search em terminais
// diferentes). Sem busy_timeout, o segundo escritor falharia na hora com SQLITE_BUSY.
db.pragma('busy_timeout = 5000');

// Busca do buscador web case/acento-insensível de verdade: o lower()/LIKE nativos só dobram
// ASCII. O chamador aplica o MESMO foldText à consulta (util.js é a única fonte do fold).
db.function('fold', { deterministic: true }, (s) => foldText(s));

// published_at é string CRUA do scrape (nem sempre ISO — ex.: "June 18, 2026"), e o date() do
// SQLite só entende ISO (senão NULL). iso_date normaliza via o MESMO parseDate do crawler p/
// YYYY-MM-DD, permitindo ordenar e filtrar período em SQL; inparseável -> NULL (cai no fallback).
db.function('iso_date', { deterministic: true }, (s) => {
  const d = parseDate(s);
  return d ? d.toISOString().slice(0, 10) : null;
});

db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  name TEXT,
  base_url TEXT UNIQUE,
  type TEXT DEFAULT 'listing',
  max_index_pages INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  source_id INTEGER REFERENCES sources(id),
  url TEXT UNIQUE,
  html_hash TEXT,
  status TEXT,
  pagination_depth INTEGER DEFAULT 0,
  fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY,
  source_id INTEGER REFERENCES sources(id),
  url TEXT UNIQUE,
  title TEXT,
  content TEXT,
  content_hash TEXT,
  published_at TEXT,
  extracted_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS selectors (
  id INTEGER PRIMARY KEY,
  template_sig TEXT UNIQUE,
  link_selector TEXT,
  link_attribute TEXT,
  content_selector TEXT,
  next_selector TEXT,
  model_used TEXT,
  confidence REAL,
  last_validated TEXT
);

CREATE TABLE IF NOT EXISTS frontier (
  id INTEGER PRIMARY KEY,
  url TEXT UNIQUE,
  kind TEXT,
  state TEXT DEFAULT 'pending',
  retries INTEGER DEFAULT 0,
  discovered_from TEXT,
  source_id INTEGER,
  depth INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_frontier_state ON frontier(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_hash ON articles(content_hash);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  command TEXT,
  args TEXT,
  budget_usd REAL,
  new_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'running',
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS classifications (
  article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  result_json TEXT NOT NULL,
  domain_confidence REAL,
  taxonomy_version TEXT,
  model_used TEXT,
  status TEXT DEFAULT 'done',
  classified_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS article_tags (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  facet TEXT NOT NULL,
  tag TEXT NOT NULL,
  rank INTEGER NOT NULL,
  PRIMARY KEY (article_id, facet, tag)
);
CREATE INDEX IF NOT EXISTS idx_article_tags_facet_tag ON article_tags(facet, tag);

CREATE TABLE IF NOT EXISTS classification_uncovered (
  id INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  facet TEXT,
  term TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY,
  run_id INTEGER REFERENCES runs(id),
  stage TEXT,
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd REAL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_run ON llm_usage(run_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER,
  source_id INTEGER,
  url TEXT,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
CREATE INDEX IF NOT EXISTS idx_events_url ON events(url);
`);

// Migração leve p/ DBs criados antes das colunas multinível (CREATE TABLE IF NOT EXISTS
// não adiciona colunas a tabelas já existentes). Idempotente: só adiciona o que falta.
function ensureColumn(table, column, ddl) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('frontier', 'depth', 'depth INTEGER DEFAULT 0');
ensureColumn('sources', 'type', "type TEXT DEFAULT 'listing'");
ensureColumn('sources', 'max_index_pages', 'max_index_pages INTEGER');
// Resumo PT-BR p/ leitura (o `content` segue original, p/ busca/tags). Ambos nullable.
ensureColumn('articles', 'title_pt', 'title_pt TEXT');
ensureColumn('articles', 'summary_pt', 'summary_pt TEXT');
// Marca d'água do delta: a execução (run) que DESCOBRIU o artigo. Linhas antigas ficam NULL.
ensureColumn('articles', 'run_id', 'run_id INTEGER');
// Colunas adicionais da tabela runs (unificada: paralel + robot-bypass). DBs antigos podem
// ter só o schema original de um dos branches; ensureColumn garante que todas existam.
ensureColumn('runs', 'command', 'command TEXT');
ensureColumn('runs', 'args', 'args TEXT');
ensureColumn('runs', 'budget_usd', 'budget_usd REAL');
ensureColumn('runs', 'status', "status TEXT DEFAULT 'running'");
ensureColumn('runs', 'new_count', 'new_count INTEGER DEFAULT 0');
// Pipeline de qualidade (curadoria de agregador + limpeza IA + verificação pós-cadastro):
// - kind: news|tool|release (item curado; NULL em linhas antigas/avulsas)
// - issue_url/section/blurb: proveniência e a descrição do PRÓPRIO agregador sobre o item
// - content_source: 'aggregator' (só o blurb) | 'target' (corpo extraído do alvo)
// - needs_enrich: 1 = cadastrado na curadoria, aguardando o corpo do alvo
// - cleaned: 1 = conteúdo passou pela limpeza por IA antes de salvar
// - verify_status/notes: veredito da verificação pós-cadastro (ok|suspect|junk)
ensureColumn('articles', 'kind', 'kind TEXT');
ensureColumn('articles', 'issue_url', 'issue_url TEXT');
ensureColumn('articles', 'section', 'section TEXT');
ensureColumn('articles', 'blurb', 'blurb TEXT');
ensureColumn('articles', 'content_source', 'content_source TEXT');
ensureColumn('articles', 'needs_enrich', 'needs_enrich INTEGER DEFAULT 0');
ensureColumn('articles', 'cleaned', 'cleaned INTEGER DEFAULT 0');
ensureColumn('articles', 'verify_status', 'verify_status TEXT');
ensureColumn('articles', 'verify_notes', 'verify_notes TEXT');
// Seletor de DATA da listagem derivado por IA lendo a página real (CSS e/ou regex), por
// template de weekly — usado pelo piso --since quando o layout não expõe <time datetime>.
ensureColumn('selectors', 'date_selector', 'date_selector TEXT');
ensureColumn('selectors', 'date_attribute', 'date_attribute TEXT');
ensureColumn('selectors', 'date_regex', 'date_regex TEXT');

// Dedup de conteúdo à prova de concorrência: promove idx_articles_hash a UNIQUE em DBs
// antigos (CREATE UNIQUE ... IF NOT EXISTS não converte um índice já existente). Só age se
// for não-único; se houver hashes duplicados pré-existentes, mantém o índice não-único.
{
  const ix = db.prepare(`SELECT "unique" AS u FROM pragma_index_list('articles') WHERE name = 'idx_articles_hash'`).get();
  if (ix && ix.u === 0) {
    try {
      db.exec('DROP INDEX idx_articles_hash; CREATE UNIQUE INDEX idx_articles_hash ON articles(content_hash);');
    } catch {
      db.exec('CREATE INDEX IF NOT EXISTS idx_articles_hash ON articles(content_hash);');
    }
  }
}

// WHERE compartilhado do buscador web (`ncrawl web`): filtros combináveis via params ANULÁVEIS
// (NULL = filtro desligado), p/ manter UM prepared statement em vez de SQL dinâmico.
// - @q: consulta já passada por foldText (a função SQL fold dobra o texto dos artigos igual).
// - @facets: objeto JSON {faceta:[tags]} — OR dentro da faceta, AND entre facetas: json_each no
//   objeto dá (key=faceta, value=array); "NOT EXISTS(faceta sem tag casando)" = todas casam.
// - @kind: 'tool'|'news' — mesma semântica de isToolByTags (taxonomy.js): ferramenta = tag da
//   faceta framework-library-tool OU content-type ∈ @toolTypes (JSON, vem de TOOL_CONTENT_TYPES).
//   A igualdade booleana `(@kind='tool') = EXISTS(...)` cobre os dois lados (news = NÃO-ferramenta).
const WEB_WHERE = `
  WHERE (@q IS NULL OR instr(
          fold(coalesce(a.title,'') || ' ' || coalesce(a.title_pt,'') || ' ' ||
               coalesce(a.summary_pt,'') || ' ' || coalesce(a.content,'')), @q) > 0)
    AND (@sourceId IS NULL OR a.source_id = @sourceId)
    AND (@from IS NULL OR coalesce(iso_date(a.published_at), date(a.extracted_at)) >= @from)
    AND (@to IS NULL OR coalesce(iso_date(a.published_at), date(a.extracted_at)) <= @to)
    AND (@facets IS NULL OR NOT EXISTS (
          SELECT 1 FROM json_each(@facets) f
          WHERE NOT EXISTS (
            SELECT 1 FROM article_tags at
             WHERE at.article_id = a.id AND at.facet = f.key
               AND at.tag IN (SELECT value FROM json_each(f.value))
          )
        ))
    AND (@kind IS NULL OR (@kind = 'tool') = (CASE
          WHEN a.kind IN ('tool', 'release') THEN 1
          WHEN a.kind = 'news' THEN 0
          ELSE EXISTS (
            SELECT 1 FROM article_tags tk
             WHERE tk.article_id = a.id
               AND (tk.facet = 'framework-library-tool'
                    OR (tk.facet = 'content-type'
                        AND tk.tag IN (SELECT value FROM json_each(@toolTypes))))
          ) END))`;

// Índice do delta por execução (run_id vem via ensureColumn, então não existe no CREATE base).
db.exec('CREATE INDEX IF NOT EXISTS idx_articles_run ON articles(run_id)');
export const stmts = {
  // sources
  upsertSource: db.prepare(
    `INSERT INTO sources (name, base_url, type, max_index_pages)
     VALUES (@name, @base_url, @type, @max_index_pages)
     ON CONFLICT(base_url) DO UPDATE SET
       name = excluded.name, type = excluded.type, max_index_pages = excluded.max_index_pages
     RETURNING *`,
  ),
  getSourceById: db.prepare(`SELECT * FROM sources WHERE id = ?`),
  listSources: db.prepare(`SELECT * FROM sources ORDER BY id`),

  // pages
  upsertPage: db.prepare(
    `INSERT INTO pages (source_id, url, html_hash, status, pagination_depth, fetched_at)
     VALUES (@source_id, @url, @html_hash, @status, @pagination_depth, datetime('now'))
     ON CONFLICT(url) DO UPDATE SET
       html_hash = excluded.html_hash, status = excluded.status,
       pagination_depth = excluded.pagination_depth, fetched_at = datetime('now')`,
  ),

  // articles (o INSERT único cobre o fluxo avulso E o item curado — needs_enrich distingue)
  insertArticle: db.prepare(
    `INSERT OR IGNORE INTO articles
       (source_id, url, title, content, content_hash, published_at, run_id,
        kind, issue_url, section, blurb, content_source, cleaned, needs_enrich)
     VALUES (@source_id, @url, @title, @content, @content_hash, @published_at, @run_id,
        @kind, @issue_url, @section, @blurb, @content_source, @cleaned, @needs_enrich)`,
  ),
  getArticleByHash: db.prepare(`SELECT id FROM articles WHERE content_hash = ?`),
  getArticleByUrl: db.prepare(`SELECT id FROM articles WHERE url = ?`),
  getArticleFullByUrl: db.prepare(`SELECT * FROM articles WHERE url = ?`),
  // Enriquecimento de item curado: preenche o corpo vindo do ALVO sem tocar kind/blurb/section.
  enrichArticle: db.prepare(
    `UPDATE articles SET title = @title, content = @content, content_hash = @content_hash,
        published_at = @published_at, content_source = @content_source, cleaned = @cleaned,
        needs_enrich = 0
      WHERE id = @id`,
  ),
  finishEnrich: db.prepare(`UPDATE articles SET needs_enrich = 0 WHERE id = ?`),
  // verificação pós-cadastro (veredito por artigo) + varredura idempotente (NULL-only)
  setVerify: db.prepare(
    `UPDATE articles SET verify_status = @verify_status, verify_notes = @verify_notes WHERE id = @id`,
  ),
  listArticlesToVerify: db.prepare(
    `SELECT id, url, title, kind, blurb, content, content_source FROM articles
      WHERE verify_status IS NULL ORDER BY id LIMIT ?`,
  ),
  listArticlesForReverify: db.prepare(
    `SELECT id, url, title, kind, blurb, content, content_source FROM articles ORDER BY id LIMIT ?`,
  ),
  listArticlesBySource: db.prepare(`SELECT * FROM articles WHERE source_id = ? ORDER BY id`),
  // delta: só os artigos descobertos numa execução (run) específica.
  listArticlesForRunBySource: db.prepare(
    `SELECT * FROM articles WHERE source_id = ? AND run_id = ? ORDER BY id`,
  ),

  // resumos PT-BR (title_pt/summary_pt; LIMIT -1 = sem limite, como em classify)
  setSummary: db.prepare(`UPDATE articles SET title_pt = @title_pt, summary_pt = @summary_pt WHERE id = @id`),
  listArticlesNeedingSummary: db.prepare(
    `SELECT id, url, title, content FROM articles WHERE summary_pt IS NULL ORDER BY id LIMIT ?`,
  ),
  listArticlesForResummarize: db.prepare(
    `SELECT id, url, title, content FROM articles ORDER BY id LIMIT ?`,
  ),
  countSummaries: db.prepare(`SELECT COUNT(*) c FROM articles WHERE summary_pt IS NOT NULL`),

  // busca: varredura completa (modo A) e retrieval por conjunto de tags (modo B, via json_each)
  listAllArticlesForSearch: db.prepare(
    `SELECT id, url, title, title_pt, summary_pt, content FROM articles ORDER BY id LIMIT ?`,
  ),
  // delta: varredura (modo A) restrita a uma execução (run).
  listRunArticlesForSearch: db.prepare(
    `SELECT id, url, title, title_pt, summary_pt, content
       FROM articles WHERE run_id = ? ORDER BY id LIMIT ?`,
  ),
  articlesByTags: db.prepare(
    `SELECT a.id, a.url, a.title, a.title_pt, a.summary_pt, a.content,
            COUNT(DISTINCT at.tag) AS matches
       FROM article_tags at
       JOIN articles a ON a.id = at.article_id
      WHERE at.tag IN (SELECT value FROM json_each(@tags))
      GROUP BY a.id
      ORDER BY matches DESC
      LIMIT @limit`,
  ),
  // delta: retrieval por tags (modo B) restrito a uma execução (run).
  articlesByTagsForRun: db.prepare(
    `SELECT a.id, a.url, a.title, a.title_pt, a.summary_pt, a.content,
            COUNT(DISTINCT at.tag) AS matches
       FROM article_tags at
       JOIN articles a ON a.id = at.article_id
      WHERE at.tag IN (SELECT value FROM json_each(@tags))
        AND a.run_id = @runId
      GROUP BY a.id
      ORDER BY matches DESC
      LIMIT @limit`,
  ),

  // buscador web (ncrawl web): página filtrada + count com o MESMO WHERE (params anuláveis)
  webSearchArticles: db.prepare(
    `SELECT a.id, a.url, a.title, a.title_pt, a.summary_pt, a.published_at, a.extracted_at,
            a.source_id, s.name AS source_name, a.kind, a.section, a.verify_status,
            substr(coalesce(a.blurb, a.content, ''), 1, 280) AS snippet
       FROM articles a
       LEFT JOIN sources s ON s.id = a.source_id
     ${WEB_WHERE}
      ORDER BY coalesce(iso_date(a.published_at), date(a.extracted_at)) DESC, a.id DESC
      LIMIT @limit OFFSET @offset`,
  ),
  webCountArticles: db.prepare(`SELECT COUNT(*) c FROM articles a ${WEB_WHERE}`),
  webGetArticle: db.prepare(
    `SELECT a.*, s.name AS source_name
       FROM articles a LEFT JOIN sources s ON s.id = a.source_id
      WHERE a.id = ?`,
  ),
  webMetaSources: db.prepare(
    `SELECT s.id, s.name, s.base_url, COUNT(a.id) AS c
       FROM sources s LEFT JOIN articles a ON a.source_id = s.id
      GROUP BY s.id
      ORDER BY c DESC, s.name`,
  ),
  webMetaTags: db.prepare(
    `SELECT facet, tag, COUNT(*) AS c FROM article_tags GROUP BY facet, tag ORDER BY facet, c DESC, tag`,
  ),
  webMetaDates: db.prepare(
    `SELECT min(coalesce(iso_date(published_at), date(extracted_at))) AS min_d,
            max(coalesce(iso_date(published_at), date(extracted_at))) AS max_d
       FROM articles`,
  ),

  // selectors (CSS de links/conteúdo/next + o par CSS+regex de DATA, tudo por template_sig)
  getSelector: db.prepare(`SELECT * FROM selectors WHERE template_sig = ?`),
  putSelector: db.prepare(
    `INSERT INTO selectors
       (template_sig, link_selector, link_attribute, content_selector, next_selector,
        date_selector, date_attribute, date_regex, model_used, confidence, last_validated)
     VALUES
       (@template_sig, @link_selector, @link_attribute, @content_selector, @next_selector,
        @date_selector, @date_attribute, @date_regex, @model_used, @confidence, datetime('now'))
     ON CONFLICT(template_sig) DO UPDATE SET
       link_selector   = excluded.link_selector,
       link_attribute  = excluded.link_attribute,
       content_selector= excluded.content_selector,
       next_selector   = excluded.next_selector,
       date_selector   = excluded.date_selector,
       date_attribute  = excluded.date_attribute,
       date_regex      = excluded.date_regex,
       model_used      = excluded.model_used,
       confidence      = excluded.confidence,
       last_validated  = datetime('now')`,
  ),

  // frontier
  enqueue: db.prepare(
    `INSERT OR IGNORE INTO frontier (url, kind, discovered_from, source_id, depth)
     VALUES (?, ?, ?, ?, ?)`,
  ),
  // retries ASC: um job devolvido a 'pending' por falha só volta DEPOIS dos jobs frescos —
  // sem isso o FIFO puro reivindica a falha de novo em segundos (hot-loop num host quebrado).
  claimNext: db.prepare(
    `UPDATE frontier SET state = 'in_progress'
     WHERE id = (SELECT id FROM frontier WHERE state = 'pending' ORDER BY retries ASC, id ASC LIMIT 1)
     RETURNING *`,
  ),
  finish: db.prepare(`UPDATE frontier SET state = ? WHERE url = ?`),
  bumpRetry: db.prepare(`UPDATE frontier SET retries = retries + 1, state = 'pending' WHERE url = ?`),
  getRetries: db.prepare(`SELECT retries FROM frontier WHERE url = ?`),
  resetInProgress: db.prepare(`UPDATE frontier SET state = 'pending' WHERE state = 'in_progress'`),
  // Re-crawl incremental: re-ativa o seed de listagem de UMA fonte (done/failed -> pending) p/
  // re-visitar a listagem e descobrir só o que é novo. Só 'listing' (seeds); roundup/article ficam.
  refreshListing: db.prepare(
    `UPDATE frontier SET state = 'pending', retries = 0
      WHERE url = ? AND kind = 'listing' AND state IN ('done', 'failed')`,
  ),
  // Item curado ainda needs_enrich cujo job já terminou (run anterior): re-ativa p/ tentar de novo.
  requeueUrl: db.prepare(
    `UPDATE frontier SET state = 'pending', retries = 0
      WHERE url = ? AND state IN ('done', 'failed')`,
  ),
  // "Enriquecer depois": no início do crawl, re-ativa os jobs de artigos que ficaram só com o
  // blurb (needs_enrich=1) — inclui os cortados por deadline no run anterior. Escopo por fonte.
  requeueNeedsEnrichForSource: db.prepare(
    `UPDATE frontier SET state = 'pending', retries = 0
      WHERE kind = 'article' AND state IN ('done', 'failed')
        AND url IN (SELECT url FROM articles WHERE needs_enrich = 1 AND source_id = ?)`,
  ),

  // events (trace por item: cada estágio grava o que fez/decidiu; `ncrawl inspect` lê daqui)
  insertEvent: db.prepare(
    `INSERT INTO events (run_id, source_id, url, stage, status, detail)
     VALUES (@run_id, @source_id, @url, @stage, @status, @detail)`,
  ),
  listEventsForRun: db.prepare(`SELECT * FROM events WHERE run_id = ? ORDER BY id`),
  listEventsForUrl: db.prepare(`SELECT * FROM events WHERE url LIKE ? ORDER BY id LIMIT ?`),
  countEventsByStage: db.prepare(
    `SELECT stage, status, COUNT(*) c FROM events WHERE run_id = ?
      GROUP BY stage, status ORDER BY stage, status`,
  ),

  // inspect (auditoria de uma run: artigos com veredito + agrupamento por issue de origem)
  getRunById: db.prepare(
    `SELECT r.*,
            (SELECT COALESCE(SUM(cost_usd), 0) FROM llm_usage u WHERE u.run_id = r.id) spent_usd
       FROM runs r WHERE r.id = ?`,
  ),
  listArticlesForRunInspect: db.prepare(
    `SELECT id, url, title, kind, section, issue_url, content_source, cleaned, needs_enrich,
            verify_status, verify_notes, published_at, length(coalesce(content,'')) AS content_len
       FROM articles WHERE run_id = ?
      ORDER BY coalesce(issue_url, ''), CASE coalesce(kind,'news')
        WHEN 'news' THEN 0 WHEN 'tool' THEN 1 WHEN 'release' THEN 2 ELSE 3 END, id`,
  ),
  countArticlesByKindForRun: db.prepare(
    `SELECT coalesce(kind, '(sem kind)') kind, COUNT(*) c FROM articles WHERE run_id = ?
      GROUP BY 1 ORDER BY c DESC`,
  ),
  countVerifyForRun: db.prepare(
    `SELECT coalesce(verify_status, '(pendente)') s, COUNT(*) c FROM articles WHERE run_id = ?
      GROUP BY 1 ORDER BY c DESC`,
  ),
  listArticlesLikeUrl: db.prepare(
    `SELECT id, url, title, kind, verify_status, verify_notes, content_source, needs_enrich
       FROM articles WHERE url LIKE ? ORDER BY id LIMIT 20`,
  ),

  // purge por fonte (protocolo "apague e refaça" reprodutível; a fonte continua cadastrada)
  countArticlesBySource: db.prepare(`SELECT COUNT(*) c FROM articles WHERE source_id = ?`),
  deleteArticlesBySource: db.prepare(`DELETE FROM articles WHERE source_id = ?`),
  deletePagesBySource: db.prepare(`DELETE FROM pages WHERE source_id = ?`),
  deleteFrontierBySource: db.prepare(`DELETE FROM frontier WHERE source_id = ?`),
  deleteEventsBySource: db.prepare(`DELETE FROM events WHERE source_id = ?`),
  deleteSelectorsLike: db.prepare(`DELETE FROM selectors WHERE template_sig LIKE ?`),

  // runs / marca d'água por execução (delta de "novo desde a última execução")
  startDeltaRun: db.prepare(`INSERT INTO runs (started_at) VALUES (datetime('now')) RETURNING id`),
  finishDeltaRun: db.prepare(`UPDATE runs SET finished_at = datetime('now'), new_count = ? WHERE id = ?`),
  getLatestRunId: db.prepare(`SELECT MAX(id) AS id FROM runs`),
  // inspect: a última run DE CRAWL (um verify/classify avulso também abre run, mas sem artigos)
  getLatestCrawlRunId: db.prepare(`SELECT MAX(id) AS id FROM runs WHERE command = 'crawl'`),
  countArticlesByRun: db.prepare(`SELECT COUNT(*) c FROM articles WHERE run_id = ?`),

  // stats
  countFrontierByState: db.prepare(`SELECT state, COUNT(*) c FROM frontier GROUP BY state`),
  countSources: db.prepare(`SELECT COUNT(*) c FROM sources`),
  countPages: db.prepare(`SELECT COUNT(*) c FROM pages`),
  countArticles: db.prepare(`SELECT COUNT(*) c FROM articles`),
  countSelectors: db.prepare(`SELECT COUNT(*) c FROM selectors`),

  // classifications (pós-processamento: 1 linha/artigo + índice normalizado + uncovered)
  upsertClassification: db.prepare(
    `INSERT INTO classifications
       (article_id, result_json, domain_confidence, taxonomy_version, model_used, status)
     VALUES (@article_id, @result_json, @domain_confidence, @taxonomy_version, @model_used, @status)
     ON CONFLICT(article_id) DO UPDATE SET
       result_json       = excluded.result_json,
       domain_confidence = excluded.domain_confidence,
       taxonomy_version  = excluded.taxonomy_version,
       model_used        = excluded.model_used,
       status            = excluded.status,
       classified_at     = datetime('now')`,
  ),
  deleteTagsForArticle: db.prepare(`DELETE FROM article_tags WHERE article_id = ?`),
  insertTag: db.prepare(
    `INSERT OR IGNORE INTO article_tags (article_id, facet, tag, rank)
     VALUES (@article_id, @facet, @tag, @rank)`,
  ),
  deleteUncoveredForArticle: db.prepare(`DELETE FROM classification_uncovered WHERE article_id = ?`),
  insertUncovered: db.prepare(
    `INSERT INTO classification_uncovered (article_id, facet, term) VALUES (@article_id, @facet, @term)`,
  ),
  getClassification: db.prepare(`SELECT * FROM classifications WHERE article_id = ?`),
  getTagsForArticle: db.prepare(
    `SELECT facet, tag, rank FROM article_tags WHERE article_id = ? ORDER BY facet, rank`,
  ),
  listArticlesNeedingClassification: db.prepare(
    `SELECT a.id, a.url, a.title, a.content
       FROM articles a
       LEFT JOIN classifications c ON c.article_id = a.id
      WHERE c.article_id IS NULL
      ORDER BY a.id
      LIMIT ?`,
  ),
  listArticlesForReclassify: db.prepare(
    `SELECT id, url, title, content FROM articles ORDER BY id LIMIT ?`,
  ),
  countClassifications: db.prepare(`SELECT COUNT(*) c FROM classifications`),
  topUncovered: db.prepare(
    `SELECT term, COUNT(*) c FROM classification_uncovered GROUP BY term ORDER BY c DESC LIMIT ?`,
  ),

  // runs / llm_usage (ledger de custo: 1 linha por run + 1 linha por chamada LLM cobrada)
  insertRun: db.prepare(
    `INSERT INTO runs (command, args, budget_usd) VALUES (@command, @args, @budget_usd) RETURNING id`,
  ),
  finishRun: db.prepare(
    `UPDATE runs SET status = @status, finished_at = datetime('now') WHERE id = @id`,
  ),
  insertLlmUsage: db.prepare(
    `INSERT INTO llm_usage (run_id, stage, model, prompt_tokens, completion_tokens, cost_usd)
     VALUES (@run_id, @stage, @model, @prompt_tokens, @completion_tokens, @cost_usd)`,
  ),
  sumUsageForRun: db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) usd, COUNT(*) n FROM llm_usage WHERE run_id = ?`,
  ),
  sumUsageTotal: db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) usd, COUNT(*) n FROM llm_usage`),
  usageByStage: db.prepare(
    `SELECT stage, COUNT(*) n, COALESCE(SUM(cost_usd), 0) usd
       FROM llm_usage WHERE run_id = ? GROUP BY stage ORDER BY usd DESC`,
  ),
  listRuns: db.prepare(
    `SELECT r.id, r.command, r.budget_usd, r.status, r.started_at, r.finished_at,
            (SELECT COALESCE(SUM(cost_usd), 0) FROM llm_usage u WHERE u.run_id = r.id) spent_usd
       FROM runs r ORDER BY r.id DESC LIMIT ?`,
  ),
  getLastRun: db.prepare(
    `SELECT r.id, r.command, r.budget_usd, r.status, r.started_at, r.finished_at,
            (SELECT COALESCE(SUM(cost_usd), 0) FROM llm_usage u WHERE u.run_id = r.id) spent_usd
       FROM runs r ORDER BY r.id DESC LIMIT 1`,
  ),
};

// Limpeza total (slate limpo). Ordem filho->pai porque foreign_keys=ON. VACUUM fora da
// transação p/ recuperar espaço do arquivo/WAL. Opera no DB de DB_PATH (respeita o override).
export function wipeAll() {
  const tables = [
    'article_tags',
    'classification_uncovered',
    'classifications',
    'articles',
    'pages',
    'selectors',
    'frontier',
    'events',
    'llm_usage',
    'runs',
    'sources',
  ];
  const tx = db.transaction(() => {
    for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
  });
  tx();
  db.exec('VACUUM');
}
