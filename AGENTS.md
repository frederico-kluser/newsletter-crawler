# AGENTS.md

Single source of truth for agents working in this repo. Keep it short; scoped detail + provenance live in `.agents/skills/`.

## Setup
- First run needs the Playwright browser: `npx playwright install chromium` (or `npm run link`). Without it,
  every anti-bot site (403 → Playwright render) fails with `browserType.launch: Executable doesn't exist`.
- OpenRouter key lives in `NC_HOME/.env` (`~/.newsletter-crawler/.env`), set via `ncrawl key set <k>` — NOT in the repo.
  npm scripts use `--env-file-if-exists=.env` so they run fine without a repo `.env` (NC_HOME still wins, see config.js).

## Commands
- build: none (pure ESM, Node >= 22, no build step — the Ink TUI uses `htm` tagged templates, NOT JSX, to stay build-free)
- smoke test: `npm run status` (imports every module + boots the SQLite schema)
- unit/eval: `npm test` (node:test — parseDate, extractPublishedDate, isBlockedPage, tag-search helpers, addSourceToConfig, UI menu + search-flow render)
- guided menu (TUI): `npm run ui` (or `node src/index.js` with no args in a TTY). `CRAWLER_LANG=pt|en`, `--no-input` disables it.
- run (bounded): `npm run crawl -- --max-pages 1 --max-articles 3`
- summaries (PT-BR): `npm run summarize` (gera title_pt/summary_pt; auto pós-crawl). Tags: `npm run classify`.
- search: `npm run search -- <consulta> --mode B` (por tags, 5 Pro) ou `--mode A --limit N --yes` (Flash, varre tudo).
- web UI (buscador): `npm run web` (ou `ncrawl web [--port N] [--no-open]`) — servidor local zero-build (React UMD + htm de node_modules, API JSON sobre o SQLite) em `http://localhost:8477`; filtros por texto/fonte/faceta/período/kind, dark+light.
- add source: `npm run add -- <url> --name "..." [--type index|listing]` (persiste em config/sources.json). export: `npm run export -- --format md`. reset: `npm run reset -- --yes` (apaga tudo).
- skills lint/eval: `node .agents/skills/scripts/skill-lint.mjs --all` / `node .agents/skills/scripts/skill-eval.mjs --all`
- (no linter / type-checker configured yet — see project-analysis.md)

## Rules (only what differs from defaults and is not tooling-guaranteed)
- ESM only; never add `axios` (supply-chain incident) — use `got`.
- Log via `util` `log`/`warn`/`errorLog`, not `console.*`.
- OpenRouter reasoning effort is `xhigh`/`high`, never `max` (DeepSeek V4 → HTTP 400).
- The project `.env` must override shell-exported vars (see `src/config.js` `loadDotEnvOverride`).
- All SQL goes through the single `stmts` object in `src/db.js`.
- The Playwright context uses `ignoreHTTPSErrors: true` (some outlets have invalid TLS cert CN, e.g. kedglobal.com).
- Full, scoped knowledge with provenance: `.agents/skills/` (start at `catalog.md`).

## Skills
Every implementation task goes through `.agents/skills/project-router`. Catalog: `.agents/skills/catalog.md`.
To evolve a skill safely: stage `<skill>/SKILL.md.next`, then `node .agents/skills/scripts/validate-skill.mjs <skill>`.

## Security
- Never read or commit `.env` or `secrets/**` (enforced by `.claude/settings.json` hooks).
