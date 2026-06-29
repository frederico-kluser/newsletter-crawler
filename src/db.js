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
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_frontier_state ON frontier(state);
CREATE INDEX IF NOT EXISTS idx_articles_hash ON articles(content_hash);
`);

export const stmts = {
  // sources
  upsertSource: db.prepare(
    `INSERT INTO sources (name, base_url) VALUES (@name, @base_url)
     ON CONFLICT(base_url) DO UPDATE SET name = excluded.name
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
    `INSERT OR IGNORE INTO frontier (url, kind, discovered_from, source_id) VALUES (?, ?, ?, ?)`,
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
};
