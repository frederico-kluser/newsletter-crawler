---
name: following-code-style
description: Coding conventions and code style for this repo - ESM modules and import order, logging via util log/warn/errorLog, defensive try/catch parsing, the single db.js stmts object, camelCase/SCREAMING_SNAKE naming, and the no-axios rule. Use whenever you write or edit JavaScript under src/, add a module, or review a diff for style, even if the user does not mention style.
metadata:
  type: knowledge
  verification_signal: node .agents/skills/scripts/skill-eval.mjs following-code-style + npm run status (boots the whole module graph; an import/syntax slip fails it)
---
# Following code style

## When to use
Before writing or editing any `src/*.js`, adding a module, or reviewing a diff. These rules are prose-only: no linter/formatter/type-checker is configured (`package.json@79fd5d8`), so you are the enforcement. Default rule: mirror the file you are editing.

## Injected knowledge
- **ESM only.** `import`/`export`, `"type":"module"`; import order is node-core (`node:` prefix) then third-party then local. `src/config.js:2-4@79fd5d8`. Why: no bundler or transpile step; a stray CJS `require` fails at runtime.
- **Keep `util.js` pure.** It exports only helpers and imports neither fetch nor db, so any module can depend on it without a cycle. `src/util.js:1@79fd5d8`.
- **Log through helpers, not `console.*`.** Use `log` / `warn` / `errorLog` from util; they prepend an ISO timestamp and level. `src/util.js:60-63@79fd5d8`. Escape hatch: a throwaway script may use console directly.
- **Defensive parsing is fail-open.** Wrap parsing of external/untrusted data (URLs, LLM JSON, HTML/DOM, robots) in try/catch and return `null`/`false`/`[]` rather than throwing. `src/util.js:6-18@79fd5d8`, `src/clean.js:11-21@79fd5d8`, `src/llm.js:44-56@79fd5d8`. Why: one bad page must not kill a long crawl. Escape hatch: throw for genuinely unrecoverable internal bugs and let the job runner retry then fail it. `src/index.js:70-79@79fd5d8`.
- **All SQL lives in the single `stmts` object** in `db.js`; named params `@field` for writes, positional `?` for simple reads; merge-on-update keeps existing columns with `??`. `src/db.js:68-132@79fd5d8`, `src/selectors.js:10-23@79fd5d8`. Do not scatter `db.prepare` across modules.
- **Naming.** functions `camelCase` verb-noun (`fetchStatic`); constants `SCREAMING_SNAKE` (`MAX_HTML_FOR_LLM`); module-private `_prefixed` (`_browser`); zod schemas `camelCase`+`Z` (`linkSelectorZ`). `src/config.js:58-62@79fd5d8`, `src/llm.js:72@79fd5d8`.
- **Comments explain WHY**; section headers use `// ---- group ----`. Existing Portuguese comments are fine - do not rewrite them. No JSDoc is used here.
- **No `axios`** (supply-chain incident; see README); all HTTP goes through `got`. `README.md@79fd5d8`.

## Evolution
On task completion, if you find an important, externally-verified convention missing here, update this file via the memory pipeline (see meta-skill-evolution). Importance alone does not authorize a write - it needs a green check or explicit user confirmation.
