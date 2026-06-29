# Skill Map — newsletter-crawler

Phase 2 artifact. The catalog is proposed BEFORE generating files. Minimal high-value set per the anti-sprawl rule (router + style + domains + testing); 9 skills total.

## Catalog

| # | name | type | why it exists | update verification signal |
|---|---|---|---|---|
| 1 | `project-router` | router | Single entry point; routes EVERY task, asks PT questions, owns TASK_PLAN.md lifecycle | `scripts/skill-eval.mjs project-router` (routing evals) |
| 2 | `following-code-style` | knowledge | ESM, logging helpers, defensive parsing, naming, `stmts` DB access — prose-only today, easy to violate | `scripts/skill-eval.mjs following-code-style` + `npm run status` (boots module graph) |
| 3 | `calling-the-llm-layer` | knowledge | OpenRouter Pro/Flash, `xhigh`-never-`max`, json_schema+zod, defensive parse, `.env` override | `scripts/skill-eval.mjs calling-the-llm-layer` + key probe `GET /api/v1/key` |
| 4 | `fetching-and-extracting` | knowledge | fetchSmart static→Playwright, prune, Readability order, robots, circuit breaker, selector thresholds | `scripts/skill-eval.mjs fetching-and-extracting` + `npm run crawl -- --max-pages 1 --max-articles 2` |
| 5 | `persisting-and-orchestrating` | knowledge | SQLite schema, `stmts`, frontier state machine, dedup, pagination stop-conditions | `scripts/skill-eval.mjs persisting-and-orchestrating` + `npm run status` (DB schema boots) |
| 6 | `running-and-verifying-crawls` | task | Bounded crawl → status → export → DB inspect → cache-hit re-run; the project's verification loop | the run commands themselves (objective pass/fail) |
| 7 | `extending-the-crawler` | task | Add a source / module / CLI command following conventions; ends with `<evolution>` | `scripts/skill-eval.mjs extending-the-crawler` + `npm run status` + bounded crawl |
| 8 | `meta-skill-evolution` | meta | End-of-task memory pipeline: update existing / propose new draft / discard | `scripts/validate-skill.mjs <skill>` must pass (lint+eval+token) |
| 9 | `meta-skill-consolidate` | meta | Periodic GC: dedup, conflict, staleness-by-provenance, token budget, second-opinion before deletion | `scripts/skill-lint.mjs --all` + `scripts/skill-eval.mjs --all` green post-consolidation |

## Dependency / composition graph

```
project-router (1)
  ├─ selects knowledge: following-code-style (2)
  │                     calling-the-llm-layer (3)
  │                     fetching-and-extracting (4)
  │                     persisting-and-orchestrating (5)
  ├─ selects task:      running-and-verifying-crawls (6) ── needs ▶ 3,4,5
  │                     extending-the-crawler (7) ────────── needs ▶ 2 + (3|4|5 per area)
  └─ on completion / gap ▶ meta-skill-evolution (8) ── uses ▶ scripts/validate-skill.mjs
meta-skill-consolidate (9)  ── scheduled GC over ▶ all of 2–7
```

- Knowledge skills (2–5) are leaf "semantic memory"; they carry the facts + provenance.
- Task skills (6–7) are "procedural memory"; they compose knowledge skills and end with `<evolution>`.
- Meta skills (8–9) never hold domain facts; they operate the pipeline and the GC.
- Parallelizable: when routed, the knowledge skills (2–5) can be loaded concurrently via isolated-context subagents; task skills run after their knowledge deps are loaded.

## Per-skill verification signal (correctness, not just hygiene)

Every knowledge/task skill update must pass `scripts/skill-eval.mjs <name>` (deterministic: lint + routing proxy + content assertions → writes a validation token). Where a runtime signal exists it is ALSO required (column above): `npm run status` boots the DB+module graph with no network; a bounded `npm run crawl` exercises fetch/LLM/extract; the OpenRouter key probe confirms the LLM path. Router/meta updates are gated by routing evals and by `validate-skill.mjs` respectively. Importance alone never authorizes a write (Huang et al.); the token IS the external signal the write-gate hook checks.

## Granularity rationale

- **Split the 4 knowledge domains** (style / LLM / fetch+extract / persist+orchestrate): each has distinct triggers and changes independently (LLM params churn separately from DB schema). One mega-skill would be retrieved for everything → routing degrades (Xiong et al. experience-following amplifies mis-retrieval).
- **Do NOT split further** (no separate robots/circuit-breaker/substack skills): those are sub-sections inside `fetching-and-extracting`; extra skills would add catalog noise without distinct triggers.
- **Singletons**: exactly one router; two meta-skills (evolution = per-task write path; consolidate = periodic GC) kept separate because they run on different cadences and have different safety gates (consolidate requires second-opinion before deletion).
- **Minimal set respected**: 9 skills (1 router + 4 knowledge + 2 task + 2 meta). New skills are added only via `meta-skill-evolution` as human-reviewed drafts.
