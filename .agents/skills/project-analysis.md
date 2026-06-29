# Project Analysis — newsletter-crawler

Phase 1 artifact. Grounds the skills system in the actual repository (docs + code), with compact provenance `path:line@shorthash`. Source commit for `src/**`: `79fd5d8`.

## 1. What this project is (normative)

A pure-Node.js (ESM) crawler that discovers, extracts, and archives newsletter articles, using an LLM (OpenRouter / DeepSeek V4) to **derive reusable CSS selectors** — not to extract page-by-page — and caching them per template in SQLite with self-healing.

Normative excerpts:
- "deriva seletores CSS via OpenRouter/DeepSeek V4 (Pro reasoning xhigh), valida com Cheerio e cacheia em SQLite com self-healing; fallback em Flash." `README.md:1-3@79fd5d8`
- "**Sem `axios`** (incidente de supply-chain de 31/03/2026); usamos `got`." `README.md`@79fd5d8 (Notas)
- "Use `\"xhigh\"`, **nunca** `\"max\"`." `README.md`@79fd5d8 (Modelos)
- Runtime contract: `"type": "module"`, `"engines": { "node": ">=22" }` `package.json:5,8@79fd5d8`. Tested on Node 24.

## 2. Stack & dependencies

ESM, Node ≥22. Key deps (`package.json:20-33@79fd5d8`): `got` (HTTP, axios-free), `playwright` (headless render), `cheerio` (CSS/validation), `jsdom`+`@mozilla/readability` (article body), `turndown` (HTML→MD), `better-sqlite3` (sync DB, WAL), `openai` (SDK→OpenRouter), `zod` (output validation), `p-limit` (concurrency), `robots-parser`, `normalize-url`.

## 3. Annotated module map

| File | Responsibility | Notable provenance |
|---|---|---|
| `src/config.js` | env+sources+constants; `.env` **override** loader | `config.js:8-37@79fd5d8` |
| `src/util.js` | pure helpers: normalizeUrl, sha256, jitter, slugify, `log/warn/errorLog` | `util.js:60-63@79fd5d8` |
| `src/db.js` | SQLite schema (WAL, FK) + single `stmts` object | `db.js:10-66,68-132@79fd5d8` |
| `src/clean.js` | `pruneForLLM`, Readability extract, turndown | `clean.js:11-52@79fd5d8` |
| `src/fetch.js` | `fetchStatic`/`fetchRendered`/`fetchSmart`, robots, circuit breaker | `fetch.js:143-176@79fd5d8` |
| `src/llm.js` | OpenRouter client + Pro/Flash derivations + defensive parse | `llm.js:28-56@79fd5d8` |
| `src/selectors.js` | cache get/put + Cheerio validation (self-healing) | `selectors.js:10-44@79fd5d8` |
| `src/substack.js` | optional Substack JSON-API shortcut | `substack.js:6-32@79fd5d8` |
| `src/crawl.js` | frontier ops, processJob, crawlArchive, pagination | `crawl.js:38-189@79fd5d8` |
| `src/index.js` | CLI (crawl/status/add/export) + resumable concurrency loop | `index.js:46-97@79fd5d8` |

## 4. Domain knowledge areas → candidate skills

1. **Code style / conventions** (ESM, logging helpers, defensive parsing, naming) → `following-code-style` (knowledge).
2. **LLM layer** (OpenRouter, Pro/Flash, reasoning efforts, json_schema+zod) → `calling-the-llm-layer` (knowledge).
3. **Fetch + extraction** (fetchSmart, prune, Readability, robots) → `fetching-and-extracting` (knowledge).
4. **Data + orchestration** (schema, frontier state machine, dedup, pagination) → `persisting-and-orchestrating` (knowledge).
5. **Run/verify** (commands, smoke tests, DB inspection) → `running-and-verifying-crawls` (task).
6. **Extend** (add source/module/CLI command following conventions) → `extending-the-crawler` (task).

## 5. Critical gotchas / non-obvious rules (highest-value knowledge)

- **`reasoning.effort` must be `"xhigh"`/`"high"`, never `"max"`** (DeepSeek V4 → 400); send only the nested `reasoning` object. `llm.js:28-29@79fd5d8`
- **Project `.env` must override shell-exported vars** — Node `--env-file` does not override inherited env; `loadDotEnvOverride` fixes a stale `OPENROUTER_API_KEY` shadowing the correct one. `config.js:8-37@79fd5d8`
- **Defensive JSON.parse even with `strict:true`** json_schema: full parse → regex `{...}` fallback → throw. `llm.js:44-56@79fd5d8`
- **Selector validity thresholds**: link selector needs ≥3 unique links; content ≥400 chars — these gate cache writes and self-healing re-derivation. `selectors.js:37-44,59-62@79fd5d8`
- **fetchSmart "needs JS" is cached per host** after a `looksEmpty` (<5 links or <500 chars) miss. `fetch.js:143-176@79fd5d8`
- **Circuit breaker** opens at 5 consecutive host errors. `fetch.js:17-21@79fd5d8`
- **`claimNext` is an atomic `UPDATE ... RETURNING`**; resume via `resetInProgress` at startup. `db.js`@79fd5d8, `index.js:52@79fd5d8`
- **Dedup** = `normalizeUrl` (strip utm_/ref, sort query) + UNIQUE(url) + `content_hash`. `util.js:6-18@79fd5d8`

## 6. Conventions guaranteed by tooling vs prose-only

**Tooling-guaranteed today: NONE.** Absent (confirmed `package.json@79fd5d8`): no test runner, no ESLint/Prettier, no TypeScript/`tsc`, no CI workflow, no pre-commit hooks, no `npm audit` gate. Every convention in §5 is therefore **prose-only** and unenforced.

Deterministic-enforcement candidates (the doctrine prefers checks over prose): add `eslint` (flat config) for import/no-unresolved + style; add a smoke test (`node --test`) that boots the DB and asserts schema; add a tiny check that greps `src/llm.js` for the literal `'max'` as reasoning value (forbidden). The skills system ships its own deterministic gates (skill-lint, skill-eval, hooks) for the knowledge layer regardless.

## 7. Verification signals available

- Runnable: `npm run crawl -- --max-pages 1 --max-articles 3`, `npm run status`, `npm run export` (`package.json:13-18@79fd5d8`). The module graph + DB init are exercised by `status` (no network/LLM).
- Key validity probe: `curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer <key>"` (200 = valid).
- For skills: `scripts/skill-lint.mjs` + `scripts/skill-eval.mjs` produce objective pass/fail and validation tokens.

## 8. Not found (declared, not invented)

No `/docs`, no ADRs (`docs/adr`, `docs/decisions`), no `CONTRIBUTING*`, no `ARCHITECTURE*`, no RFCs, no pre-existing `AGENTS.md`/`CLAUDE.md`, no CI config. README.md is the only narrative doc; `config/sources.json` is the only runtime config.
