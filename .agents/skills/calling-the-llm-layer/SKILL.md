---
name: calling-the-llm-layer
description: OpenRouter and DeepSeek V4 integration for the LLM layer - model slugs, reasoning effort xhigh/high (never max), json_schema strict plus zod validation, defensive JSON parse, the two-tier Pro/Flash strategy, and the .env key override. Use whenever you touch the LLM layer (src/llm.js), change prompts, schemas, reasoning, or models, or debug an OpenRouter 400 or 401 error.
metadata:
  type: knowledge
  verification_signal: node .agents/skills/scripts/skill-eval.mjs calling-the-llm-layer + OpenRouter key probe (GET /api/v1/key -> 200) + a bounded crawl exercising a real Pro call
---
# Calling the LLM layer

## When to use
Editing `src/llm.js`, changing any OpenRouter/DeepSeek call, prompt, json schema, reasoning effort, or model; or debugging a 400/401 from OpenRouter.

## Injected knowledge
- **Reasoning effort: Pro uses `xhigh`, Flash uses `high`. Never `max`** - DeepSeek V4 rejects `max` with HTTP 400. Send only the nested `reasoning` object; never also pass `reasoning_effort`. `src/llm.js:28-29@79fd5d8`.
- **Two-tier strategy.** Pro (`deepseek/deepseek-v4-pro`, xhigh) derives reusable selectors - `deriveLinkSelector`, `deriveContentSelector` - one amortized call per template. Flash (`deepseek/deepseek-v4-flash`, high) does cheap fallbacks - `deriveNextLink`, `extractLinksItemByItem`, `extractArticleViaLLM`. `src/llm.js:77-204@79fd5d8`. Why cost: xhigh reasoning is billed as output tokens, so use Pro only to derive/repair selectors, not per page.
- **Structured output + defensive parse.** Use `response_format` json_schema with `strict:true`, but still parse defensively: full `JSON.parse`, then regex-extract `{...}`, then throw; and validate every result with a zod schema before use. `src/llm.js:44-56,72-76@79fd5d8`. Why: strict is not an absolute guarantee.
- **SDK details.** The `openai` SDK points at the OpenRouter baseURL; in JS it forwards unknown fields (so `reasoning` passes through). Send `HTTP-Referer` and `X-Title` via defaultHeaders; `maxRetries:3` covers 429/5xx. `src/llm.js:13-17@79fd5d8`.
- **Token discipline.** Always `pruneForLLM` and clamp to `MAX_HTML_FOR_LLM` before sending HTML. `src/llm.js:59@79fd5d8`. See fetching-and-extracting for pruning.
- **The `.env` key override gotcha.** `config.js` loads the project `.env` and overrides shell-exported vars, because Node `--env-file` does not override inherited env - a stale exported `OPENROUTER_API_KEY` otherwise shadows the correct one and yields `401 "User not found"`. `src/config.js:8-37@79fd5d8`. Probe a key: `curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer <key>"` (200 = valid).

## Evolution
On task completion, persist a new LLM-layer fact here only if an external signal confirms it (a green bounded crawl, a successful API response, or user confirmation). See meta-skill-evolution.
