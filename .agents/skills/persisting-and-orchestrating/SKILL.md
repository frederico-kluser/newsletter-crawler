---
name: persisting-and-orchestrating
description: SQLite data layer and crawl orchestration - schema and tables, the prepared statements (stmts), the frontier state machine (pending, in_progress, done, failed) with resume and depth, multi-level archives (index/roundup/article), dedup via normalizeUrl and content_hash, the concurrency loop, and pagination stop conditions. Use whenever you edit src/db.js, src/crawl.js, or src/index.js, or change the schema, the frontier or queue, dedup, or pagination.
metadata:
  type: knowledge
  verification_signal: node .agents/skills/scripts/skill-eval.mjs persisting-and-orchestrating + npm run status (creates/boots the schema and runs the count queries)
---
# Persisting and orchestrating

## When to use
Editing `src/db.js` (schema/statements), `src/crawl.js` (frontier/pagination), or `src/index.js` (loop); touching dedup or the queue.

## Injected knowledge
- **Schema.** Tables `sources`, `pages`, `articles`, `selectors`, `frontier`; `UNIQUE(url)` on each URL-bearing table; `content_hash` (indexed) for cross-URL dedup; pragmas `journal_mode=WAL` and `foreign_keys=ON`. `src/db.js:10-66@79fd5d8`.
- **Adding a column needs a migration.** `CREATE TABLE IF NOT EXISTS` never adds columns to an existing DB, so new columns (`frontier.depth`, `sources.type`, `sources.max_index_pages`) go through an idempotent `ensureColumn` (PRAGMA table_info -> ALTER TABLE) right after the schema exec, AND in the CREATE for fresh DBs. `src/db.js:95-104@3113fa6`. Verified: `npm run status` migrated a pre-existing DB cleanly.
- **All SQL via one `stmts` object.** `claimNext` is an atomic `UPDATE frontier SET state='in_progress' ... RETURNING *` (hands out one job at a time, safe under the async loop); `enqueue` is `INSERT OR IGNORE` (URL dedup in the queue, now also carries `depth`); upserts use `ON CONFLICT`. `src/db.js:68-132@79fd5d8`.
- **Frontier state machine.** `pending -> in_progress -> done | failed`. Resume: `resetInProgress()` at startup flips stale `in_progress` back to `pending`. Retry: `bumpRetry` increments and re-queues until `MAX_RETRIES`, then `finish('failed')`. `src/index.js:52,70-79@79fd5d8`.
- **Multi-level archives (index -> roundup -> article).** A source with `type:'index'` treats its discovered links as `roundup` jobs (newsletter issues), whose curated external links become `article` jobs; `frontier.depth` carries the level and `MAX_CRAWL_DEPTH` bounds recursion. An article that is really a low-prose link collection is split into N (still bounded by depth). `domainSig` is path-aware for listings (host:listing:/path-template) so `/issues` and `/issues/<slug>` don't share one cached selector; articles stay one template per host. `src/crawl.js:82-102,248-293@3113fa6`, `src/util.js:43-60@3113fa6`. Verified: aiweekly crawl index(1)->roundup(10)->article.
- **Concurrency loop.** `pLimit(CONCURRENCY)` plus an `inflight` Set plus `Promise.race`; the loop stops when `inflight` is empty and `claimNext` returns nothing. `--max-articles` caps further claiming (counts only `article` jobs). `src/index.js:64-92@79fd5d8`.
- **Pagination (`crawlArchive`) stop conditions:** an empty page (selector yields under the min links), a repeated `html_hash`, no next link, or `depth+1 >= maxPages` (skips the final `findNextPage`, avoiding a wasted LLM call). `findNextPage` order: cached `next_selector` -> `<a rel="next">` -> `?page=N+1` -> LLM (caches the discovered `next_selector`). `src/crawl.js:172-246@79fd5d8`.
- **Dedup.** `normalizeUrl` strips `utm_*`/`ref`/`fbclid`/`gclid`, sorts query params, drops the hash and trailing slash; combined with `UNIQUE(articles.url)` and `content_hash`. `src/util.js:6-18@79fd5d8`.

## Evolution
On task completion, update this file only for an important, externally-verified change (e.g., `npm run status` boots the new schema cleanly). See meta-skill-evolution.
