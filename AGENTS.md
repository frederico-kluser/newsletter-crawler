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
- run (bounded): `npm run crawl -- --max-pages 1 --max-articles 3`. Cada run re-visita as listagens e traz só o NOVO (`--no-refresh` desliga; a paginação para na 1ª página sem itens novos). Modo agressivo (ignora robots.txt + UA de navegador real; NÃO salva página de desafio) é o **DEFAULT** — `--no-aggressive`/`CRAWLER_AGGRESSIVE=false` volta ao educado. Toda run grava em `runs` + `articles.run_id`.
- pipeline de qualidade (default ON): issues de fontes `index` são CURADAS por IA **por seção** (1 agente Flash por News/Tools/Releases/… em paralelo, `splitIntoSections`) em itens `kind` news|tool|release com o blurb do agregador (cadastro na curadoria; o corpo do alvo vira enriquecimento — `needs_enrich`, e alvo raso/bloqueado NÃO perde o item); conteúdo extraído passa por limpeza IA pré-save (`sanityCheckCleaned` anti-truncamento) e por um guard de TEXTO PURO no armazenamento (`ensurePlainText` — o "HTML cru na UI" era content salvo com tags, nunca render); verificação (ok|suspect|junk), classificação de tags e resumos PT-BR rodam **em streaming** logo após cada enriquecimento (`streamPostSave`, + sweeps finais de rede de segurança, delta-only). Classify usa **modelo por faceta** (`classify:<faceta>` em models.json rebaixa difficulty/content-type/trending p/ Flash). Desliga: `CURATE_ROUNDUPS`/`CLEAN_BEFORE_SAVE`/`VERIFY_AFTER_CRAWL`/`{VERIFY,CLASSIFY,SUMMARIZE}_STREAMING=false`, `--no-verify`.
- robustez de paralelismo: o parse JSDOM/Readability roda num **pool de workers** (`src/parse-{core,worker,pool}.js`) — um SIGSEGV mata só o worker, o pool respawna e a task cai num default seguro (`PARSE_IN_WORKERS=false` força inline; `PARSE_WORKERS`/`PARSE_TIMEOUT_MS`). **Deadline por job** de artigo (`JOB_TIMEOUT_MS`, 90s; roundup/listing isentos): estourou, a ficha fica com o blurb e re-enfileira no próximo crawl. Curadoria (listing/roundup) tem **pool de reivindicação próprio** (`claimNextArticle`/`claimNextCurate`, set `curating`, `CURATE_JOBS`) p/ a fase LLM longa não travar o fetch dos artigos; a lane llm no crawl é `0.6n` (piso 3). Eventos gravados **em lote** (buffer transacional, flush no `finally` de `runWithLimits`). Custo de IA **ao vivo**: painel da TUI (gasto + chamadas + por etapa) e linha `gasto parcial` no CLI (`COST_LOG_INTERVAL_MS`); a web mostra o acumulado (`apiMeta.cost`).
- auditoria: `npm run inspect` (última run: itens por issue, vereditos, motivos de skip; `--run N`, `--url <substr>`, `--verbose`) — lê a tabela `events` (trace por estágio, fail-open). `npm run verify -- [--force]` re-verifica; `npm run reclean -- [--limit N]` re-limpa os `suspect` com passe FORTE (Pro, stage `articleReclean`) e re-verifica. `npm run purge -- <fonte> --yes [--selectors]` apaga os DADOS de uma fonte (ela continua cadastrada) p/ refazer do zero.
- summaries (PT-BR): `npm run summarize` (gera title_pt/summary_pt; auto pós-crawl). Tags: `npm run classify`.
- search: `npm run search -- <consulta> --mode B` (por tags, 5 Pro) ou `--mode A --limit N --yes` (Flash, varre tudo). Default busca só a última run; `--all` = acervo todo.
- web UI (buscador): `npm run web` (ou `ncrawl web [--port N] [--no-open]`) — servidor local zero-build (React UMD + htm de node_modules, API JSON sobre o SQLite) em `http://localhost:8477`; filtros por texto/fonte/faceta/período/kind, dark+light.
- add source: `npm run add -- <url> --name "..." [--type index|listing]` (persiste em config/sources.json). export: `npm run export -- --format md [--all]` (default = última run; `--all` = acervo todo). reset: `npm run reset -- --yes` (apaga tudo).
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
