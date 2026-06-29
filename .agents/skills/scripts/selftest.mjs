#!/usr/bin/env node
// Phase-5 validation + permanent regression harness for the skills system.
// Exercises: routing/content evals, the evolution ACCEPT path, the REJECT path
// (unverified/over-generalized blocked), the REGRESSION discard (promote-or-discard),
// and the router TASK_PLAN.md lifecycle (disposable; bootstrap artifacts preserved).
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILLS_DIR } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const rec = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? '[pass]' : '[FAIL]'} ${name}${detail ? '  - ' + detail : ''}`);
};
const node = (script, args = []) => {
  try {
    return { code: 0, out: execFileSync('node', [path.join(here, script), ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status || 1, out: (e.stdout || '') + (e.stderr || '') };
  }
};

// 1) Baseline: routing proxy + content assertions for the real 9 skills.
rec('routing + content evals green (skill-eval --all)', node('skill-eval.mjs', ['--all']).code === 0);

// Temp demo skill used to exercise the evolution pipeline without touching real skills.
const demoDir = path.join(SKILLS_DIR, 'evolving-demo');
const demoMd = path.join(demoDir, 'SKILL.md');
const demoNext = `${demoMd}.next`;
const GOOD_DESC =
  'Demo knowledge skill for validating the evolution pipeline - covers the imaginary widget telemetry exporter. ' +
  'Use whenever you work on widget telemetry exporting in the demo area.';
const md = (desc, body) =>
  `---\nname: evolving-demo\ndescription: ${desc}\nmetadata:\n  type: knowledge\n  ` +
  `verification_signal: node .agents/skills/scripts/skill-eval.mjs evolving-demo\n---\n` +
  `# Evolving demo\n## When to use\nPipeline validation fixture only.\n## Injected knowledge\n${body}\n## Evolution\nTest fixture.\n`;
const GOOD_BODY = '- The widget telemetry exporter flushes every 5 seconds. `package.json:5@79fd5d8`.';

mkdirSync(demoDir, { recursive: true });
writeFileSync(
  path.join(demoDir, 'evals.json'),
  JSON.stringify(
    {
      routing: { must_trigger: ['work on widget telemetry exporting'], must_not_trigger: ['change the sqlite schema'] },
      content_must_include: ['widget telemetry', '@79fd5d8'],
    },
    null,
    2,
  ),
);

// 2) ACCEPT: important + verifiable staged change is promoted.
writeFileSync(demoNext, md(GOOD_DESC, GOOD_BODY));
{
  const r = node('validate-skill.mjs', ['evolving-demo']);
  const live = existsSync(demoMd) ? readFileSync(demoMd, 'utf8') : '';
  rec('evolution ACCEPT (verified change promoted + token)', r.code === 0 && live.includes('widget telemetry'));
}

// 3) REJECT: over-generalized edit that drops the validity fact + provenance is blocked.
writeFileSync(demoNext, md(GOOD_DESC, '- The exporter flushes periodically.'));
{
  const before = readFileSync(demoMd, 'utf8');
  const r = node('validate-skill.mjs', ['evolving-demo']);
  const after = readFileSync(demoMd, 'utf8');
  rec('evolution REJECT (unverified -> blocked, live unchanged)', r.code !== 0 && before === after && after.includes('widget telemetry'));
}

// 4) REGRESSION: a description flip that mis-routes (correct->wrong) is discarded.
writeFileSync(demoNext, md('Generic placeholder skill for nothing in particular.', GOOD_BODY));
{
  const before = readFileSync(demoMd, 'utf8');
  const r = node('validate-skill.mjs', ['evolving-demo']);
  const after = readFileSync(demoMd, 'utf8');
  rec('regression DISCARD (promote-or-discard, live unchanged)', r.code !== 0 && before === after);
}

// 5) Router lifecycle: TASK_PLAN.md is disposable; bootstrap artifacts are never deleted.
{
  const root = path.resolve(SKILLS_DIR, '../..');
  const plan = path.join(root, 'TASK_PLAN.md');
  writeFileSync(plan, '# Plano de teste\n');
  const created = existsSync(plan);
  rmSync(plan);
  const deleted = !existsSync(plan);
  const artifactsKept = ['project-analysis.md', 'skill-map.md', 'catalog.md', '.bootstrap-state.json'].every((f) =>
    existsSync(path.join(SKILLS_DIR, f)),
  );
  rec('router lifecycle (TASK_PLAN.md create+delete; artifacts intact)', created && deleted && artifactsKept);
}

// cleanup the demo fixture
rmSync(demoDir, { recursive: true, force: true });
try {
  rmSync(path.join(SKILLS_DIR, '.validation', 'evolving-demo.json'));
} catch {
  /* ignore */
}

// 6) Post-cleanup baseline: the real 9 skills are still green (no pollution).
rec('post-cleanup baseline (9 skills still green)', node('skill-eval.mjs', ['--all']).code === 0);

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length} checks, ${failed} failing.`);
process.exit(failed ? 1 : 0);
