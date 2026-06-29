---
name: meta-skill-consolidate
description: Periodic garbage-collection over all skills - dedup redundant content, resolve conflicts, detect staleness by provenance hash, enforce a per-skill token budget, and retire obsolete content. Use on a schedule or when skills grow or overlap, never as part of a feature task. Deletions require a second-opinion review.
metadata:
  type: meta
  verification_signal: node .agents/skills/scripts/skill-lint.mjs --all + node .agents/skills/scripts/skill-eval.mjs --all green after consolidation (regression gating)
---
# Meta-skill: consolidate (GC)

Periodic only, never inline with a feature task. Reversible edits are free; deletions are not (reversibility guardrail).

## Procedure
1. **DEDUP**. Scan all skills; merge duplicated content (by pattern-key) into the single best location.
2. **CONFLICT**. Re-run conflict detection across skills; resolve contradictions by replacing the stale passage.
3. **STALENESS by provenance**. For each `file:line@hash`, if the cited file's commit/hash changed, mark the passage "to revalidate", then revalidate against the current source or retire it.
4. **TOKEN BUDGET**. Enforce body < 500 lines / ~5k tokens per skill; move long material to `references/`.
5. **GATING**. After edits, run `skill-lint.mjs --all` and `skill-eval.mjs --all`; promote only if green (no regressions). Emit a diff for review.
6. **DELETION SAFETY**. Removing a skill or a large passage requires a SECOND-OPINION subagent review (consensus) and respects reversibility - propose, never silently delete. Git enables rollback.
