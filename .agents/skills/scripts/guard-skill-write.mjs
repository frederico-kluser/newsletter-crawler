#!/usr/bin/env node
// PreToolUse write-gate. Blocks a direct Write/Edit to any **/SKILL.md unless a
// FRESH "pass" validation token exists for that skill. This makes the external-
// validation rule a guarantee: SKILL.md changes must go through skill-eval /
// validate-skill (which write the token). Fail-open on parse errors.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readToken } from './lib.mjs';

const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h freshness window
const allow = () => process.exit(0);
const block = (m) => {
  console.error(m);
  process.exit(2);
};

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  allow();
}

if (!['Write', 'Edit', 'MultiEdit'].includes(payload.tool_name || '')) allow();
const fp = payload.tool_input?.file_path || payload.tool_input?.path || '';
if (!fp.endsWith('SKILL.md')) allow();

const name = path.basename(path.dirname(fp));
const tok = readToken(name);
const fresh = tok && tok.status === 'pass' && Date.now() - tok._mtimeMs < MAX_AGE_MS;
if (fresh) allow();

block(
  `[skill-write-gate] Blocked direct write to ${name}/SKILL.md without a fresh validation token.\n` +
    `Stage your change in ${name}/SKILL.md.next and run:\n` +
    `  node .agents/skills/scripts/validate-skill.mjs ${name}\n` +
    `(lint + eval -> promotes SKILL.md and writes the token). External-validation rule: ` +
    `no SKILL.md persists without an objective pass.`,
);
