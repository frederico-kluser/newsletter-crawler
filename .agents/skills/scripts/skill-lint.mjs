#!/usr/bin/env node
// Deterministic skill linter — enforces the authoring rules as a hard gate.
// Usage: node skill-lint.mjs [<skill-name> | --all]
import { listSkillDirs, parseSkill } from './lib.mjs';

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PROVENANCE_RE = /[\w./-]+:\d+(?:[-,]\d+)*@[0-9a-f]{7,40}/; // path:line(-range,list)@shorthash
const VALID_TYPES = ['knowledge', 'task', 'router', 'meta'];

function lintSkill(name) {
  const errors = [];
  const warnings = [];
  let s;
  try {
    s = parseSkill(name);
  } catch (e) {
    return { name, errors: [`cannot read SKILL.md: ${e.message}`], warnings };
  }
  const { fm, body } = s;
  const meta = fm.metadata && typeof fm.metadata === 'object' ? fm.metadata : {};
  const type = meta.type;

  if (!s.frontmatter) errors.push('missing YAML frontmatter (--- ... ---)');

  if (!fm.name) errors.push('frontmatter.name missing');
  else {
    if (!NAME_RE.test(fm.name)) errors.push(`name "${fm.name}" must be kebab-case [a-z0-9-]`);
    if (fm.name.length > 64) errors.push(`name >64 chars (${fm.name.length})`);
    if (fm.name !== name) warnings.push(`name "${fm.name}" != directory "${name}"`);
  }

  if (!fm.description) errors.push('frontmatter.description missing');
  else {
    if (fm.description.length > 1024) errors.push(`description >1024 chars (${fm.description.length})`);
    if (fm.description.length < 40) warnings.push('description <40 chars (weak selection signal)');
    if (!/\b(use|when|whenever|trigger|before|after)\b/i.test(fm.description))
      warnings.push('description has no explicit "when to use"/trigger cue');
  }

  if (!type) errors.push('metadata.type missing');
  else if (!VALID_TYPES.includes(type)) errors.push(`metadata.type "${type}" not in ${VALID_TYPES.join('|')}`);

  if ((type === 'knowledge' || type === 'task') && !meta.verification_signal)
    errors.push('metadata.verification_signal required for knowledge/task skills');

  if ((type === 'knowledge' || type === 'task') && fm.name) {
    const gerund = fm.name.split('-').some((t) => t.endsWith('ing'));
    if (!gerund) warnings.push(`name "${fm.name}" not gerund form (verb+-ing) expected for ${type}`);
  }

  for (const k of Object.keys(fm))
    if (!['name', 'description', 'metadata'].includes(k)) warnings.push(`unexpected frontmatter key "${k}"`);

  const lines = body.split('\n').length;
  if (lines >= 500) errors.push(`body ${lines} lines (limit <500)`);
  const tokens = Math.round(body.length / 4);
  if (tokens > 5000) warnings.push(`body ~${tokens} tokens (>5000 target; move detail to references/)`);

  if (type === 'knowledge' && !PROVENANCE_RE.test(body))
    errors.push('knowledge skill has no provenance reference (path/file:line@hash)');

  if ((type === 'task' || type === 'router') && !/<evolution>|## Evolution|evolution/i.test(body) && type === 'task')
    warnings.push('task skill should end with an <evolution> step');

  return { name, type, errors, warnings, tokens, lines };
}

const arg = process.argv[2];
const names = arg && arg !== '--all' ? [arg] : listSkillDirs();
if (names.length === 0) {
  console.log('no skills found');
  process.exit(0);
}
let failed = 0;
for (const n of names) {
  const r = lintSkill(n);
  if (r.errors.length) failed++;
  console.log(`[${r.errors.length ? 'FAIL' : 'pass'}] ${n} (${r.type || '?'}, ~${r.tokens ?? '?'}t, ${r.lines ?? '?'}L)`);
  for (const e of r.errors) console.log(`   x ${e}`);
  for (const w of r.warnings) console.log(`   ! ${w}`);
}
console.log(`\n${names.length} skill(s) linted, ${failed} failing.`);
process.exit(failed ? 1 : 0);
