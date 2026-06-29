---
name: running-and-verifying-crawls
description: How to run, smoke test, and verify the crawler end to end - npm run status, npm run crawl with --max-pages and --max-articles bounds, the cache-hit re-run check, DB inspection, markdown export, and the OpenRouter key probe. Use whenever you need to run the app, test a change, reproduce a crawl, or verify a fix works.
metadata:
  type: task
  verification_signal: the run commands themselves (npm run status; npm run crawl -- --max-pages 1 --max-articles 3; npm run export) produce an objective pass/fail
---
# Running and verifying crawls

## When to use
Running, smoke-testing, reproducing, or verifying the crawler end to end after any change.

## Procedure
1. **Deps (first time only):** `npm install` then `npx playwright install chromium`.
2. **Smoke test (no network/LLM):** `npm run status` - imports every module and boots the SQLite schema; an import or syntax error fails here first. `package.json:15@79fd5d8`.
3. **Bounded crawl:** `npm run crawl -- --max-pages 1 --max-articles 3` - keeps token cost and time small while exercising fetch + LLM + extract.
4. **Inspect:** `npm run status` - sources/pages/articles/selectors/frontier counts should be > 0; for detail, open the DB read-only with better-sqlite3.
5. **Cache-hit / resume check:** re-run step 3. Expect NO `seletor derivado` line (selector cache hit, zero Pro cost) and the `pending` count to drop - this proves the self-healing cache and resumability.
6. **Export:** `npm run export -- --format md` writes `data/export/<source>/*.md` (or `--format json`).
7. **On 401s:** `curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer <key>"` (200 = valid). The cause is usually a stale shell `OPENROUTER_API_KEY`; see calling-the-llm-layer for the `.env` override.

Knowledge deps to load first: calling-the-llm-layer, fetching-and-extracting, persisting-and-orchestrating.

## <evolution>
On completion, if a new verification step proved necessary AND you confirmed it by actually running it, update THIS skill's Procedure via the memory pipeline (replace the relevant step; keep it lean). Never record a step you did not run. See meta-skill-evolution.
