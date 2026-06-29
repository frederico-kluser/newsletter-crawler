#!/usr/bin/env node
// Per-skill eval gate: lint + content assertions + deterministic routing proxy.
// On pass, writes a validation token (the external signal the write-gate checks).
// Usage: node skill-eval.mjs [<skill-name> | --all]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listSkillDirs, parseSkill, loadEvals, buildRouterIndex, routeQuery,
  sha256, tokenPath, VALIDATION_DIR,
} from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function lintPass(name) {
  try {
    execFileSync('node', [path.join(here, 'skill-lint.mjs'), name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function evalSkill(name, index) {
  const problems = [];
  const s = parseSkill(name);
  const type = s.fm.metadata?.type;
  const evals = loadEvals(name);

  if (!lintPass(name)) problems.push('skill-lint failed (run skill-lint.mjs for details)');

  if (!evals) {
    if (type === 'knowledge' || type === 'task') problems.push('missing evals.json (required for knowledge/task)');
  } else {
    for (const sub of evals.content_must_include || []) {
      if (!s.body.includes(sub)) problems.push(`content_must_include missing: "${sub}"`);
    }
    const r = evals.routing || {};
    for (const q of r.must_trigger || []) {
      const ranked = routeQuery(q, index);
      if (!ranked.length || ranked[0].name !== name || ranked[0].score === 0) {
        problems.push(`must_trigger not top for "${q}" -> ${ranked[0]?.name || 'none'}(${ranked[0]?.score ?? 0})`);
      }
    }
    for (const q of r.must_not_trigger || []) {
      const ranked = routeQuery(q, index);
      if (ranked.length && ranked[0].name === name && ranked[0].score > 0) {
        problems.push(`must_not_trigger wrongly top for "${q}"`);
      }
    }
  }
  return problems;
}

const arg = process.argv[2];
const names = arg && arg !== '--all' ? [arg] : listSkillDirs();
const index = buildRouterIndex();
mkdirSync(VALIDATION_DIR, { recursive: true });

let failed = 0;
for (const name of names) {
  const problems = evalSkill(name, index);
  if (problems.length) {
    failed++;
    console.log(`[FAIL] ${name}`);
    for (const p of problems) console.log(`   x ${p}`);
    writeFileSync(tokenPath(name), JSON.stringify({ status: 'fail', validated_at: new Date().toISOString() }, null, 2));
  } else {
    const hash = sha256(parseSkill(name).raw);
    writeFileSync(tokenPath(name), JSON.stringify({ status: 'pass', hash, validated_at: new Date().toISOString() }, null, 2));
    console.log(`[pass] ${name} -> token`);
  }
}
console.log(`\n${names.length} skill(s) evaluated, ${failed} failing.`);
process.exit(failed ? 1 : 0);
