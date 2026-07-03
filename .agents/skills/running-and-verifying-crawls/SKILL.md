---
name: running-and-verifying-crawls
description: How to run, smoke test, and verify the crawler end to end - npm run status, npm test, npm run crawl with --max-pages/--max-articles/--since bounds, npm run reset, the cache-hit re-run check, DB inspection (status counts), markdown export, the site publish flow, the web UI check, and the OpenRouter key probe. Use whenever you need to run the app, test a change, reproduce a crawl, or verify a fix works.
metadata:
  type: task
  verification_signal: the run commands themselves (npm test; npm run status; npm run crawl -- --max-pages 1 --max-articles 3; npm run export) produce an objective pass/fail
---
# Running and verifying crawls

## When to use
Running, smoke-testing, reproducing, or verifying the crawler end to end after any change.

## Procedure
1. **Deps (first time only):** `npm install` then `npx playwright install chromium`.
2. **Smoke test (no network/LLM):** `npm run status` - imports every module and boots the SQLite schema; an import or syntax error fails here first. `package.json:15@79fd5d8`.
3. **Unit/eval (no network):** `npm test` (node:test) - covers `parseDate`, `extractPublishedDate`, `isBlockedPage`, the web API (ephemeral port + temp `NC_HOME`), and the UI renders; catches a date-parse, anti-bot, or query regression in milliseconds without a crawl. `package.json@7bf9a26`, `test/@47bfa19`.
4. **Bounded crawl:** `npm run crawl -- --max-pages 1 --max-articles 3` - keeps token cost and time small while exercising fetch + LLM + extract.
5. **Inspect:** `npm run status` - sources/pages/articles/selectors/frontier counts should be > 0; for detail, open the DB read-only with better-sqlite3.
6. **Cache-hit / resume check:** re-run step 4. Expect NO `seletor derivado` line (selector cache hit, zero Pro cost) and the `pending` count to drop - this proves the self-healing cache and resumability. **Terminar um backlog SEM novo crawl:** `npm run finish -- [--budget USD] [--parallel N] [--limit N] [--no-verify|--no-classify|--no-summarize]` roda verify+classify+summarize dos PENDENTES no perfil `llm-only` (delta/idempotente; `--budget` para no teto e devolve os pendentes → retomável). Re-rodar `crawl` também faz `resetInProgress` (in_progress→pending) + os sweeps. `cmdFinish` (`src/commands.js`) espelha o bloco pós-crawl; item "Finalizar pendentes" no menu da TUI.
7. **Export:** `npm run export -- --format md` writes `data/export/<source>/*.md` (or `--format json`). **Publicar o site:** `--format web` regenera os 3 JSONs commitados de `webapp/public/data` (determinístico: só `meta.json.generatedAt` muda entre 2 exports sem dado novo). Fluxo normal = só `git push` na main — o hook `.githooks/pre-push` (instalado por `postinstall` → `core.hooksPath`) exporta, auto-commita se houver dado novo e ABORTA o push (commit criado durante o push não entra nele; repita o push), e a Vercel (Git integration) publica. Verificar o deploy sem dashboard: `gh api repos/<owner>/<repo>/deployments` + `.../commits/<sha>/status` (context `Vercel`, state `success`). Verified: 600→1588 artigos publicados pelo próprio hook (stale→commit+abort; fresh→passa) + deploy Production success. `.githooks/pre-push@081f064`, `src/export-web.js@081f064`.
8. **Date-bounded + dedup:** `npm run crawl -- --source "AI Weekly" --since 2026-06-25` stops paginating at the floor (log: `piso atingido, parando paginação`); assert via read-only SQLite that NO saved article is dated below the floor and there is no duplicate `url`/`content_hash`. `npm run reset -- --yes` wipes ALL data between runs (respects `DB_PATH`; `--yes` required). `src/index.js@7bf9a26`. Verified: floor stop + 0 duplicates on aiweekly.
9. **Web UI (`ncrawl web`):** boot `node src/index.js web --port <p> --no-open` in the background, probe `/api/meta` and `/api/articles?...` with curl, then verify the VISUAL layer with the repo's own playwright (screenshot light/dark × desktop/mobile) while listening to `pageerror` — a blank page means a JS error (an htm `<>` fragment did exactly that), and `document.scrollingElement.scrollWidth > window.innerWidth` pinpoints responsive overflow to the exact element. For seeded UI states (facets/tool badge), point `NC_HOME` at a temp dir and insert fixtures via `stmts` before `startWebServer({port: 0})`. Verified: both real bugs were caught and fixed this way. `@47bfa19`.
10. **On 401s:** `curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer <key>"` (200 = valid). The cause is usually a stale shell `OPENROUTER_API_KEY`; see calling-the-llm-layer for the `.env` override.

Knowledge deps to load first: calling-the-llm-layer, fetching-and-extracting, persisting-and-orchestrating.

## <evolution>
On completion, if a new verification step proved necessary AND you confirmed it by actually running it, update THIS skill's Procedure via the memory pipeline (replace the relevant step; keep it lean). Never record a step you did not run. See meta-skill-evolution.
