#!/usr/bin/env node
// Safe evolution path (promote-or-discard). Stage new content in <skill>/SKILL.md.next,
// then: node validate-skill.mjs <skill>. Runs lint + eval against the staged content;
// on PASS it promotes (writes SKILL.md via fs, bypassing the Write-tool gate) and the
// eval writes the validation token; on FAIL it leaves the live SKILL.md unchanged.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillPath } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const name = process.argv[2];
if (!name) {
  console.error('usage: validate-skill.mjs <skill-name>');
  process.exit(1);
}

const target = skillPath(name);
const staged = `${target}.next`;
const hasStage = existsSync(staged);
if (!hasStage && !existsSync(target)) {
  console.error(`no ${name}/SKILL.md or SKILL.md.next to validate`);
  process.exit(1);
}

let backup = null;
const wasNew = hasStage && !existsSync(target);
if (hasStage) {
  if (existsSync(target)) backup = readFileSync(target, 'utf8');
  writeFileSync(target, readFileSync(staged, 'utf8')); // try the staged content in place
}

function run(script) {
  try {
    return { ok: true, out: execFileSync('node', [path.join(here, script), name], { encoding: 'utf8' }) };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const lint = run('skill-lint.mjs');
const evalr = lint.ok ? run('skill-eval.mjs') : { ok: false, out: '(eval skipped: lint failed)' };
console.log((lint.out + evalr.out).trim());

if (lint.ok && evalr.ok) {
  if (hasStage) rmSync(staged);
  console.log(`[validate-skill] ${name}: PASS — ${hasStage ? 'promoted from .next, ' : ''}token written.`);
  process.exit(0);
}

// FAIL: revert to keep the live skill clean (promote-or-discard). Keep .next for the human to fix.
if (backup != null) writeFileSync(target, backup);
else if (wasNew) {
  try {
    rmSync(target);
  } catch {
    /* ignore */
  }
}
console.error(`[validate-skill] ${name}: FAIL — live SKILL.md left unchanged; fix ${name}/SKILL.md.next and retry.`);
process.exit(1);
