---
name: extending-the-crawler
description: How to extend the crawler following its conventions - add a newsletter source (edit config/sources.json or the add command), add a new src/ module, add a CLI command, register a publication, or add a new fetch/extract strategy. Use whenever you add a source, feature, module, command, or new capability to the crawler.
metadata:
  type: task
  verification_signal: node .agents/skills/scripts/skill-eval.mjs extending-the-crawler + npm run status + a bounded npm run crawl after the change
---
# Extending the crawler

## When to use
Adding a newsletter source, a new `src/` module, a CLI command, a publication, or a new fetch/extract strategy.

## Procedure
- **Add a source:** edit `config/sources.json` (`{name,url[,render]}`) or run `npm run add -- <url> --name "..."`; then a bounded crawl to confirm links are found and a selector is derived and cached. `config/sources.json@79fd5d8`.
- **Add a module:** create `src/<name>.js` in ESM following `following-code-style`; import it where used; keep all SQL in the `db.js` `stmts` object and all LLM calls in `llm.js`.
- **Add a CLI command:** extend the flag parser and the command dispatch in `src/index.js`, then add an npm script in `package.json` that runs with `--env-file=.env`. `src/index.js:46-97@79fd5d8`.
- **Add a fetch/extract strategy:** place it behind `fetchSmart`/`clean.js`; see `fetching-and-extracting`.
- Always reuse util/db/llm/fetch/clean/selectors; never add `axios`; log via the util helpers.
- Verify the change via `running-and-verifying-crawls`.

## <evolution>
On completion, if you discovered an important, externally-verified convention, update the relevant KNOWLEDGE skill (not this one) via the memory pipeline. Update this skill only when the extension procedure itself changed and you verified the new steps. See meta-skill-evolution.
