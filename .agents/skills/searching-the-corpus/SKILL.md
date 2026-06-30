---
name: searching-the-corpus
description: How to search the saved newsletter base and generate PT-BR summaries - the two search modes (Flash per-article relevance vs 5 Pro tag-derivation + tag retrieval), the news/tool bucketing, the summarize stage, and reuse of the existing tag taxonomy. Use whenever you change src/search.js, src/summarize.js, the search/summarize commands or UI, or add tag-based retrieval.
metadata:
  type: task
  verification_signal: npm test (taxonomy.search) + npm run summarize -- --limit 2 (writes PT-BR) + npm run search -- "<q>" --mode B (5 Pro -> tags -> buckets) + --mode A --limit N --yes (Flash scan)
---
# Searching the corpus (+ PT-BR summaries)

## When to use
Editing `src/search.js`, `src/summarize.js`, the `search`/`summarize` commands, or the search UI (`SearchConfig`/`ResultsView`); adding tag-based retrieval.

## Procedure / injected knowledge
- **The tag system ALREADY EXISTS — reuse it.** 9 facets, `config/taxonomy.json` (8 domains, aliases, limits, mandatory), classification in `src/classify.js`/`src/taxonomy.js`, persisted to `article_tags` (article_id, facet, tag, rank), auto post-crawl. Do NOT rebuild the taxonomy.
- **PT-BR summaries keep the original.** `articles.content` stays original (search/tags read it); the `summarize` stage (Flash high) writes `articles.title_pt` + `articles.summary_pt` (a readable PT-BR summary, NOT a literal full translation). `summarizePending` is idempotent (`summary_pt IS NULL`) + a post-crawl hook (`SUMMARIZE_AFTER_CRAWL`). `src/summarize.js@b7ee2f7`.
- **Search Mode A (exhaustive).** `searchRelevance` = Flash high, `pLimit(SEARCH_FLASH_CONCURRENCY=50)` over ALL articles; `judgeRelevance` returns `{relation: direct|similar|none, kind: news|tool}` — the json_schema has NO enum (strict isn't a guarantee); the zod `.transform` clamps to the allowed sets and a per-article try/catch fails open to `none`. Cost guard: above `SEARCH_MODE_A_CONFIRM` articles the command needs `--yes`. `src/search.js@b7ee2f7`, `src/llm.js@b7ee2f7`.
- **Search Mode B (tag-based, cheap).** Exactly 5 Pro calls, one per `RETRIEVAL_FACETS` (domain, topic-technology, framework-library-tool, concept-theme, trending-emerging): `buildFacetQueryPrompt(facet, query)` maps the query to that facet's vocab tags, validated through the EXISTING `validateFacetTags`; union the tags; `stmts.articlesByTags` retrieves via `json_each(@tags)` ranked by match count. Requires classification to have run. `src/taxonomy.js@b7ee2f7`, `src/db.js@b7ee2f7`.
- **Buckets news vs tool.** Every result splits into Notícias/Ferramentas. Mode A uses the LLM `kind`; Mode B uses `isToolByTags` (a `framework-library-tool` tag OR a content-type in tool-release/tooling/library-release/product-launch). `src/taxonomy.js@b7ee2f7`.
- **Results to the UI.** `cmdSearch` RETURNS the results object; `RunView` captures the resolved value and (for `sub==='search'`) calls `onResults` so App swaps to `ResultsView` (scrollable, `useInput`-only). Live scan progress via a module global `getSearchProgress()` polled by RunView. `src/ui/RunView.js@b7ee2f7`, `src/ui/ResultsView.js@b7ee2f7`.

## <evolution>
On completion, update this skill only for an important, externally-verified change (a green `npm test` + a live `search`/`summarize` run). See meta-skill-evolution.
