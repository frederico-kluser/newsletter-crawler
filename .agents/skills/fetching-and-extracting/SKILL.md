---
name: fetching-and-extracting
description: HTML fetching and content extraction - the fetchSmart static to Playwright rendering decision, DOM pruning, Readability first article extraction, robots politeness, the circuit breaker, and CSS selector validation thresholds. Use whenever you edit src/fetch.js, src/clean.js, or src/selectors.js, or change Playwright scrolling, rendering, robots, pruning, or selector validation.
metadata:
  type: knowledge
  verification_signal: node .agents/skills/scripts/skill-eval.mjs fetching-and-extracting + npm run crawl -- --max-pages 1 --max-articles 2 (exercises fetch + prune + extract)
---
# Fetching and extracting

## When to use
Editing `src/fetch.js`, `src/clean.js`, `src/selectors.js`; touching Playwright, robots, DOM pruning, Readability, or selector validation.

## Injected knowledge
- **fetchSmart decision.** Try static `got` first; if `looksEmpty` (fewer than 5 links OR under 500 chars of body text) render with Playwright and cache `needsJs=true` per host so the choice is not re-made. `forceRender` bypasses the heuristic. `src/fetch.js:143-176@79fd5d8`. Why: pay the browser cost only when the raw HTML is JS-gated.
- **Playwright.** One shared browser singleton; block `image`/`media`/`font` requests; `waitUntil:'domcontentloaded'` with 45s timeout; `autoScroll` until `scrollHeight` plateaus (max 60 rounds); `clickLoadMore` matches a PT/EN regex (mais|more|older|antig|load|proxim|next), max 50 clicks. `src/fetch.js:74-139@79fd5d8`.
- **pruneForLLM lives in `clean.js`.** Removes script/style/noscript/svg/iframe/link/meta/head/nav/footer/aside/form/template and keeps only `href`/`class`/`id`; output clamped to `MAX_HTML_FOR_LLM`. `src/clean.js:36-52@79fd5d8`. Why: cut tokens massively before any LLM call.
- **Article extraction order.** Readability first (accept when `textContent` >= 400 chars); else a cached Pro-derived `content_selector`; else `extractArticleViaLLM` (Flash). `src/clean.js:11-21@79fd5d8`, `src/selectors.js@79fd5d8`, `src/crawl.js@79fd5d8`.
- **robots + politeness.** robots.txt is cached per host and fails open (allow) if the fetch fails; honor Crawl-delay (seconds to ms). Per-fetch `jitterDelay(REQUEST_DELAY_MS)`; per-host `pLimit(PER_HOST_CONCURRENCY)`. Toggle with `CRAWLER_RESPECT_ROBOTS`. `src/fetch.js:23-49,56@79fd5d8`.
- **Circuit breaker** opens after 5 consecutive errors for a host (further fetches throw). `src/fetch.js:17-21@79fd5d8`.
- **Selector validity thresholds** gate cache writes and self-healing: a link selector needs >= 3 unique normalized links; content needs >= 400 chars. Below threshold, re-derive. `src/selectors.js:37-44,59-62@79fd5d8`.

## Evolution
On task completion, update this file only for an important, externally-verified change (a green bounded crawl that proves the new behavior). See meta-skill-evolution.
