---
name: fetching-and-extracting
description: HTML fetching and content extraction - the fetchSmart static to Playwright rendering decision, DOM pruning, Readability first article extraction, robots politeness, the circuit breaker, anti-bot interstitial rejection, newsletter-issue link extraction, and CSS selector validation thresholds. Use whenever you edit src/fetch.js, src/clean.js, or src/selectors.js, or change Playwright scrolling, rendering, robots, pruning, or selector validation.
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
- **Chromium MUST launch with `--no-sandbox`** (defaults also include `--disable-dev-shm-usage`, `--disable-gpu`) in containers/CI: without it chromium aborts and the failure is a **V8 fatal that kills the whole Node process** (exit 133), NOT a catchable exception — so a single bad fetch ends the crawl. Override with `CRAWLER_CHROMIUM_ARGS` (comma-separated). `src/fetch.js:76-90@3113fa6`. Verified: reproduced the V8 abort on a live crawl, fixed by the args.
- **pruneForLLM lives in `clean.js`.** Removes script/style/noscript/svg/iframe/link/meta/head/nav/footer/aside/form/template and keeps only `href`/`class`/`id`; output clamped to `MAX_HTML_FOR_LLM`. `src/clean.js:41-53@79fd5d8`. Why: cut tokens massively before any LLM call.
- **Article extraction order.** Readability first (accept when `textContent` >= 400 chars); else a cached Pro-derived `content_selector`; else `extractArticleViaLLM`. `src/clean.js:11-21@79fd5d8`, `src/selectors.js@79fd5d8`, `src/crawl.js@79fd5d8`.
- **Newsletter issue/roundup link extraction is LLM-free via Readability.** The curated EXTERNAL links of an issue are the `<a>` inside Readability's `.content` body (`readableLinks`/`linksInHtml` in clean.js) — Readability already strips nav, prev/next, and SPONSOR blocks, so you get the real source links without a selector or LLM call. `deriveLinkSelector` does NOT work on issue pages (its prompt targets internal "editions", returning prev/next). Fallback only if Readability yields too few: `extractRoundupLinks` (LLM). `src/clean.js:37-90@3113fa6`, `src/crawl.js@3113fa6`. Verified: 11 external links extracted from an aiweekly issue, sponsor-free.
- **Reject anti-bot interstitials.** Cloudflare/captcha challenge pages ("Just a moment...", "Attention Required", "verify you are human", "enable javascript and cookies") return HTTP 200 with body text and otherwise pass the >=50-char content check — `isBlockedPage(title, text)` must gate the save so they don't become junk articles. `src/clean.js:64-86@3113fa6`. Verified: a live crawl saved "Just a moment..." until this guard was added.
- **robots + politeness.** robots.txt is cached per host and fails open (allow) if the fetch fails; honor Crawl-delay (seconds to ms). Per-fetch `jitterDelay(REQUEST_DELAY_MS)`; per-host `pLimit(PER_HOST_CONCURRENCY)`. Toggle with `CRAWLER_RESPECT_ROBOTS`. `src/fetch.js:23-49,56@79fd5d8`.
- **Circuit breaker** opens after 5 consecutive errors for a host (further fetches throw). `src/fetch.js:17-21@79fd5d8`.
- **Selector validity thresholds** gate cache writes and self-healing: a link selector needs >= 3 unique normalized links; content needs >= 400 chars. Below threshold, re-derive. `src/selectors.js:37-44,59-62@79fd5d8`.

## Evolution
On task completion, update this file only for an important, externally-verified change (a green bounded crawl that proves the new behavior). See meta-skill-evolution.
