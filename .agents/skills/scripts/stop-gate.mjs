#!/usr/bin/env node
// Bootstrap Stop gate: blocks turn termination until every phase in
// .bootstrap-state.json is done+gate_passed. Fail-OPEN by design (a Stop hook
// that errors must never trap the session). Inert once bootstrap completes.
import { readFileSync } from 'node:fs';
import path from 'node:path';

function exitAllow() { process.exit(0); }

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  exitAllow();
}

// Already continuing because of a prior Stop block -> never loop.
if (payload.stop_hook_active) exitAllow();

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
let state;
try {
  state = JSON.parse(readFileSync(path.join(projectDir, '.agents/skills/.bootstrap-state.json'), 'utf8'));
} catch {
  exitAllow(); // no state file -> nothing to enforce
}

const phases = Array.isArray(state.phases) ? state.phases : [];
const incomplete = phases.filter((p) => !(p.done && p.gate_passed));
if (incomplete.length === 0) exitAllow(); // all green -> inert

const pending = incomplete.map((p) => `#${p.id} ${p.name}`).join('; ');
console.error(
  `Bootstrap incomplete — continue the mission before stopping. Pending: ${pending}. ` +
    `(Guarded against loops: this blocks at most once per stop attempt.)`,
);
process.exit(2);
