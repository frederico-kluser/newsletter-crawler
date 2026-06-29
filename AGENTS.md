# AGENTS.md

Single source of truth for agents working in this repo. Keep it short; scoped detail + provenance live in `.agents/skills/`.

## Commands
- build: none (pure ESM, Node >= 22, no build step)
- smoke test: `npm run status` (imports every module + boots the SQLite schema)
- run (bounded): `npm run crawl -- --max-pages 1 --max-articles 3`
- export: `npm run export -- --format md`
- skills lint/eval: `node .agents/skills/scripts/skill-lint.mjs --all` / `node .agents/skills/scripts/skill-eval.mjs --all`
- (no test runner / linter / type-checker configured yet — see project-analysis.md)

## Rules (only what differs from defaults and is not tooling-guaranteed)
- ESM only; never add `axios` (supply-chain incident) — use `got`.
- Log via `util` `log`/`warn`/`errorLog`, not `console.*`.
- OpenRouter reasoning effort is `xhigh`/`high`, never `max` (DeepSeek V4 → HTTP 400).
- The project `.env` must override shell-exported vars (see `src/config.js` `loadDotEnvOverride`).
- All SQL goes through the single `stmts` object in `src/db.js`.
- Full, scoped knowledge with provenance: `.agents/skills/` (start at `catalog.md`).

## Skills
Every implementation task goes through `.agents/skills/project-router`. Catalog: `.agents/skills/catalog.md`.
To evolve a skill safely: stage `<skill>/SKILL.md.next`, then `node .agents/skills/scripts/validate-skill.mjs <skill>`.

## Security
- Never read or commit `.env` or `secrets/**` (enforced by `.claude/settings.json` hooks).
