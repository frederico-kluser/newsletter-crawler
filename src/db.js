// Persistência SQLite (better-sqlite3): schema + prepared statements.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DB_PATH } from './config.js';

mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

  // articles
  insertArticle: db.prepare(
    `INSERT OR IGNORE INTO articles (source_id, url, title, content, content_hash, published_at)
     VALUES (@source_id, @url, @title, @content, @content_hash, @published_at)`,
  ),
  getArticleByHash: db.prepare(`SELECT id FROM articles WHERE content_hash = ?`),
  getArticleByUrl: db.prepare(`SELECT id FROM articles WHERE url = ?`),
  listArticlesBySource: db.prepare(`SELECT * FROM articles WHERE source_id = ? ORDER BY id`),

  // selectors
  getSelector: db.prepare(`SELECT * FROM selectors WHERE template_sig = ?`),
  putSelector: db.prepare(
    `INSERT INTO selectors
       (template_sig, link_selector, link_attribute, content_selector, next_selector, model_used, confidence, last_validated)
     VALUES
       (@template_sig, @link_selector, @link_attribute, @content_selector, @next_selector, @model_used, @confidence, datetime('now'))
     ON CONFLICT(template_sig) DO UPDATE SET
       link_selector   = excluded.link_selector,
       link_attribute  = excluded.link_attribute,
       content_selector= excluded.content_selector,
       next_selector   = excluded.next_selector,
       model_used      = excluded.model_used,
       confidence      = excluded.confidence,
       last_validated  = datetime('now')`,
  ),

  // frontier
  enqueue: db.prepare(
    `INSERT OR IGNORE INTO frontier (url, kind, discovered_from, source_id, depth)
     VALUES (?, ?, ?, ?, ?)`,
  ),
  claimNext: db.prepare(
    `UPDATE frontier SET state = 'in_progress'
     WHERE id = (SELECT id FROM frontier WHERE state = 'pending' ORDER BY id LIMIT 1)
     RETURNING *`,
  ),
  finish: db.prepare(`UPDATE frontier SET state = ? WHERE url = ?`),
  bumpRetry: db.prepare(`UPDATE frontier SET retries = retries + 1, state = 'pending' WHERE url = ?`),
  getRetries: db.prepare(`SELECT retries FROM frontier WHERE url = ?`),
  resetInProgress: db.prepare(`UPDATE frontier SET state = 'pending' WHERE state = 'in_progress'`),

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
    'sources',
  ];
  const tx = db.transaction(() => {
    for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
  });
  tx();
  db.exec('VACUUM');
}
