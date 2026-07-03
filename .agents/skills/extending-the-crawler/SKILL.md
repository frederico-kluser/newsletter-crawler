---
name: extending-the-crawler
description: How to extend the crawler following its conventions - add or replace a newsletter source (the add command / UI wizard persists to the LIVE NC_HOME/sources.json; the repo config/sources.json is only the fresh-install seed), crawl a subset via --sources/--source/--only, add a new src/ module, add a CLI command, register a publication, or add a new fetch/extract strategy. Use whenever you add a source, feature, module, command, or new capability to the crawler.
metadata:
  type: task
  verification_signal: node .agents/skills/scripts/skill-eval.mjs extending-the-crawler + npm run status + a bounded npm run crawl after the change
---
# Extending the crawler

## When to use
Adding a newsletter source, a new `src/` module, a CLI command, a publication, or a new fetch/extract strategy.

## Procedure
- **Add/replace a source — there are TWO sources.json and only ONE is live.** `loadSources()` lê **`NC_HOME/sources.json`** (`SOURCES_PATH`); o `config/sources.json` do repo é só o SEED, copiado UMA vez p/ instalação nova (`seedFile`, `src/config.js:351-362@d3abce8`). `npm run add`/o wizard persistem via `addSourceToConfig` (upsert por URL normalizada) no arquivo VIVO — então **trocar o conjunto de fábrica = editar OS DOIS** (o seed commitado + o NC_HOME do usuário em runtime, que instalações existentes mantêm). A fonte aparece no **checkbox de fontes** da tela Coletar (`SourcesStep`, multi-select) e é re-semeada a cada crawl. `type:'index'` = links são issues/roundups; default `listing` = links são artigos. Config e DB são DESACOPLADOS: remover do config não esconde artigos já coletados (web UI/status/export leem o DB); `purge` apaga os dados mas mantém a linha em `sources`. Fábrica atual = 6 Cooperpress `/issues` (Node/JavaScript Weekly, Frontend Focus, React Status, Postgres/Golang Weekly) — o arquivo Cooperpress lista ~600 issues numa página: **1ª coleta SEMPRE bounded** (`--since`/`--max-articles`; o piso de data descarta o histórico: `abaixoDoPiso=654` no archive/ok). Then run a bounded crawl to confirm links are found and a selector is derived/cached.
- **Crawl a subset:** `--sources "A,B"` (lista por vírgula; cada item por nome exato case-insensitive OU URL normalizada — helper puro `filterSeedSources`, exportado de `src/commands.js@d3abce8`; PRECEDÊNCIA sobre `--source`/`--only` com `warn`, e `warn` por item sem match — nunca no-op silencioso; flag sem valor = ausente). É o que o checkbox da TUI emite. O filtro age no SEED: jobs pendentes de runs anteriores (outras fontes) ainda são drenados — bounded runs continuam retomáveis. Verified: `test/commands.sources-filter.test.js` + coleta real (só as 2 fontes pedidas entraram em `sources`).
- **Add a module:** create `src/<name>.js` in ESM following `following-code-style`; import it where used; keep all SQL in the `db.js` `stmts` object and all LLM calls in `llm.js`.
- **Add a CLI command:** put the body in `src/commands.js` (side-effect-free, exported), wire it into the dispatch in `src/index.js` (each branch ends `db.close()`), add an npm script in `package.json` (`--env-file=.env`), and — for the UI — a screen in `src/ui/screens.js` + a THUNK/route in `src/ui/App.js`. `src/index.js@fc0e1be`, `src/commands.js@fc0e1be`.
- **Add a fetch/extract strategy:** place it behind `fetchSmart`/`clean.js`; see `fetching-and-extracting`.
- Always reuse util/db/llm/fetch/clean/selectors; never add `axios`; log via the util helpers.
- Verify the change via `running-and-verifying-crawls`.

## <evolution>
On completion, if you discovered an important, externally-verified convention, update the relevant KNOWLEDGE skill (not this one) via the memory pipeline. Update this skill only when the extension procedure itself changed and you verified the new steps. See meta-skill-evolution.
