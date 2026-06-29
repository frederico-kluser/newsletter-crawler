# Validation Report — skills system

Phase 5 artifact. All checks are reproducible: `node .agents/skills/scripts/selftest.mjs`.

## Self-test results (deterministic harness)
```
[pass] routing + content evals green (skill-eval --all)
[pass] evolution ACCEPT (verified change promoted + token)
[pass] evolution REJECT (unverified -> blocked, live unchanged)
[pass] regression DISCARD (promote-or-discard, live unchanged)
[pass] router lifecycle (TASK_PLAN.md create+delete; artifacts intact)
[pass] post-cleanup baseline (9 skills still green)
6 checks, 0 failing.
```

## Evidence per requirement
- **Routing evals.** Every knowledge/task skill ships `evals.json` with `must_trigger` queries (must select it) and `must_not_trigger` near-misses (must not). `skill-eval.mjs` resolves them with a deterministic term-overlap router proxy; 9/9 green. The proxy fix that mattered: presence-based scoring (unique terms) so a repeated word can't inflate a skill's score.
- **Evolution ACCEPT.** A staged `SKILL.md.next` that is lint-clean, keeps its provenance, and passes its evals is promoted by `validate-skill.mjs` and a `pass` token is written.
- **Evolution REJECT (clean-but-wrong blocked).** An over-generalized edit that drops the validity fact and provenance fails lint/eval; `validate-skill.mjs` leaves the live `SKILL.md` unchanged. This is the success_criteria #12 case: a tidy update with no external signal is refused.
- **Regression DISCARD.** A description flip that mis-routes a previously-passing `must_trigger` query is detected as a correct→wrong flip and discarded (promote-or-discard).
- **Hooks demonstrably block.** `guard-skill-write.mjs`: unvalidated `SKILL.md` write → exit 2; validated → 0; non-`SKILL.md` → 0. `security-guardrail.mjs`: read `.env` / `cat .env` / `rm -rf /` → exit 2; `.env.example` / `npm run crawl` / `git push` → 0.
- **Router lifecycle.** `TASK_PLAN.md` is created then deleted; the bootstrap artifacts (project-analysis.md, skill-map.md, catalog.md, .bootstrap-state.json) remain. `TASK_PLAN.md` is git-ignored.
- **App integration.** `npm run status` still boots the module graph + DB after the whole system was added (no regression to the crawler).

## success_criteria recheck
| # | criterion | status | evidence |
|---|---|---|---|
| 1 | lean skills; valid frontmatter (gerund/kebab/≤64; desc ≤1024 what+when) | PASS | skill-lint --all 0 fails; bodies ~330–610 tokens |
| 2 | exactly one project-router | PASS | catalog.md `## router` has one entry |
| 3 | every task skill ends with `<evolution>`; no learnings system | PASS | grep `<evolution>` in both task skills; no LEARNINGS.md |
| 4 | evolution + consolidation meta-skills w/ safeguards as checks/hooks | PASS | meta-skill-evolution/-consolidate + validate-skill + hooks |
| 5 | persisted knowledge respects rules a–g | PASS | see design-principles recheck |
| 6 | knowledge is a reviewable DRAFT; no generic overviews / unexplained CAPS; meta proposes drafts | PASS | skills give exact commands + why; evolution proposes, never auto-publishes |
| 7 | portable: `.agents/skills` source + documented symlink; frontmatter name+description(+metadata) | PASS | `.claude/skills -> ../.agents/skills`; lint restricts top-level keys |
| 8 | each phase artifact committed | PASS | commits 836ed9b, ce7d0e9, 5d4cd81, e0851ed, + this |
| 9 | router asks PT questions, creates+deletes TASK_PLAN.md, keeps bootstrap artifacts | PASS | router content invariants + lifecycle test |
| 10 | first action = repo docs grounding | PASS | Phase 1 grounding in project-analysis.md |
| 11 | deterministic enforcement (linter + 3 hooks) | PASS | skill-lint + guard-skill-write + security-guardrail + stop-gate |
| 12 | 5 phases complete autonomously; Stop hook + state guard; clean-but-wrong blocked | PASS | .bootstrap-state.json all green; REJECT test |

## design_principles a–g recheck
- **a IMPORTANT/SELECTIVE** — skills hold only non-obvious facts (thresholds, the never-`max` rule, the `.env` override), not trivia.
- **b MINIMAL + scope kept** — each rule states its validity scope (e.g., "DeepSeek V4", "per host", "knowledge skills").
- **c CITED** — `file:line@hash` provenance in every knowledge skill (lint-enforced; ranges allowed).
- **d CLEAN STATE / git history** — no dates/changelogs in skill files; history lives in git.
- **e EXTERNAL VERIFICATION before persist** — write-gate + token; REJECT test proves a no-signal write is refused.
- **f REGRESSION GATING** — promote-or-discard; regression test proves a correct→wrong flip is discarded.
- **g CONFLICT DETECTION** — evolution step 3 replaces (never appends) contradictions; consolidate re-runs it across all skills.

## Gaps and proposed fixes (honest)
1. **Routing proxy ≠ real LLM router.** The deterministic proxy validates that descriptions carry distinctive triggers; runtime selection is the model's. Fix: optionally add LLM-judged routing evals later.
2. **Hook activation.** New hooks in `.claude/settings.json` may need a Claude Code session restart (and first-use approval) to fire; they are proven here via direct script invocation. Documented for the user.
3. **Project code still lacks tests/lint/CI** (only the skills layer is gated). Candidate deterministic enforcement (see project-analysis.md §6): `eslint` flat config, a `node:test` smoke that boots the schema, a CI workflow, and a guard that greps `src/llm.js` for a forbidden `'max'` reasoning value.
4. **Entailment is pipeline-instructed, not fully automated** in evolution step 2 — acceptable, since entailment is one of several allowed external signals (tests/build/lint/eval/user-confirmation cover the automated ones).
