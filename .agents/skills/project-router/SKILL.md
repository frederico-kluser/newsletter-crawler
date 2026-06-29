---
name: project-router
description: Routes EVERY implementation task in this codebase to the correct skills BEFORE any step. Use whenever the user asks for any change, fix, feature, analysis, refactor, or run - even if they do not mention skills. Asks clarifying questions in Brazilian Portuguese and manages the TASK_PLAN.md lifecycle.
metadata:
  type: router
  verification_signal: node .agents/skills/scripts/skill-eval.mjs project-router (content invariants) + routing evals in validation-report.md
---
# Project Router

IMPORTANT: all questions and interactions with the user are ALWAYS in BRAZILIAN PORTUGUESE.

## Protocol (run BEFORE any work)
1. ASK A LOT (in Portuguese). Ask SEVERAL clarifying questions first: exact scope, expected inputs/outputs, constraints, edge cases, acceptance criteria, and what explicitly NOT to do. Do not advance while the task is underspecified; keep asking until ambiguity is gone.
2. Create TASK_PLAN.md (in Portuguese) with the detailed plan, steps, and the acceptance criteria agreed with the user.
3. Classify the task: domain(s) touched, type (bug/feature/refactor/analysis/run), complexity.
4. Consult catalog.md and select the relevant knowledge + task skills. On ambiguity, prefer the most domain-specific skill.
5. Assemble the skill CHAIN (order + what can run in parallel via isolated-context subagents).
6. Load the selected skills' knowledge BEFORE implementing.
7. Execute the chain following TASK_PLAN.md.
8. ON COMPLETION: (a) run each involved task skill's <evolution> (the memory pipeline in meta-skill-evolution); (b) DELETE TASK_PLAN.md.

## Rules
- If no skill covers the task, invoke meta-skill-evolution to PROPOSE a new skill (a human-reviewed draft, not a direct publish).
- Skills with broad side effects (deploy, structural changes) are NOT auto-invocable without user confirmation.
- Never skip the evolution step on completion. Never leave TASK_PLAN.md behind.
- TASK_PLAN.md is disposable and deleted at the end; the bootstrap artifacts (project-analysis.md, skill-map.md, catalog.md, validation-report.md, .bootstrap-state.json) are NOT - never delete them.

## Routing quick map
- code style / new module / naming / logging -> following-code-style
- OpenRouter / DeepSeek / reasoning / json_schema / 400-401 -> calling-the-llm-layer
- fetch / Playwright / Readability / robots / selectors -> fetching-and-extracting
- schema / frontier / dedup / pagination / queue -> persisting-and-orchestrating
- run / test / verify / export / status -> running-and-verifying-crawls
- add source / module / command / feature -> extending-the-crawler
