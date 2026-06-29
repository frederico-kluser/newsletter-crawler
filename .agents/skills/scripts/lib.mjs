// Shared helpers for the skill tooling (lint, eval, validate, hooks, catalog).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// scripts/ lives at .agents/skills/scripts -> SKILLS_DIR is its parent.
export const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VALIDATION_DIR = path.join(SKILLS_DIR, '.validation');

export const RESERVED_DIRS = new Set(['scripts', 'references', '.validation']);

export function sha256(s) {
  return crypto.createHash('sha256').update(s || '').digest('hex');
}

export function listSkillDirs() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !RESERVED_DIRS.has(d.name))
    .map((d) => d.name)
    .filter((name) => existsSync(path.join(SKILLS_DIR, name, 'SKILL.md')))
    .sort();
}

export const skillPath = (name) => path.join(SKILLS_DIR, name, 'SKILL.md');
export const evalsPath = (name) => path.join(SKILLS_DIR, name, 'evals.json');
export const tokenPath = (name) => path.join(VALIDATION_DIR, `${name}.json`);

export function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: null, body: raw, fm: {} };
  const fm = {};
  let current = null;
  for (const line of m[1].split('\n')) {
    if (/^\s+\S/.test(line) && current) {
      const mm = line.match(/^\s+([\w-]+):\s*(.*)$/);
      if (mm) fm[current][mm[1]] = mm[2].trim();
    } else {
      const mm = line.match(/^([\w-]+):\s*(.*)$/);
      if (mm) {
        const [, key, rawVal] = mm;
        const val = rawVal.trim();
        if (val === '') {
          fm[key] = {};
          current = key;
        } else {
          fm[key] = val;
          current = null;
        }
      }
    }
  }
  return { frontmatter: m[1], body: m[2], fm };
}

export function parseSkill(name) {
  const raw = readFileSync(skillPath(name), 'utf8');
  return { name, path: skillPath(name), raw, ...parseFrontmatter(raw) };
}

export function loadEvals(name) {
  try {
    return JSON.parse(readFileSync(evalsPath(name), 'utf8'));
  } catch {
    return null;
  }
}

export function readToken(name) {
  try {
    const tok = JSON.parse(readFileSync(tokenPath(name), 'utf8'));
    tok._mtimeMs = statSync(tokenPath(name)).mtimeMs;
    return tok;
  } catch {
    return null;
  }
}

// Deterministic routing simulator: score each skill's description against a
// query by trigger-term overlap. This is a runnable proxy for LLM routing so
// the gate has an objective pass/fail (the real router is the LLM at runtime).
const STOP = new Set(
  ('a an the to of in on for and or with without is are be do does how what when whenever ' +
    'i we you it this that any some change fix add update please skill skills use using used ' +
    'o a as os de da do em no na para com sem e ou que como quando qual um uma').split(' '),
);

export function terms(text) {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9+.-]{1,}/g) || []).filter((t) => !STOP.has(t) && t.length > 2);
}

export function scoreSkillForQuery(descTerms, queryTerms) {
  const qset = new Set(queryTerms);
  let score = 0;
  for (const t of descTerms) if (qset.has(t)) score += 1;
  return score;
}

export function buildRouterIndex() {
  return listSkillDirs().map((name) => {
    const { fm } = parseSkill(name);
    return { name, type: fm.metadata?.type, descTerms: terms(fm.description || '') };
  });
}

// Returns the skill names ranked best-first for a query (excluding router/meta,
// which are infra, unless includeInfra is set).
export function routeQuery(query, index = buildRouterIndex(), { includeInfra = false } = {}) {
  const q = terms(query);
  return index
    .filter((s) => includeInfra || (s.type !== 'router' && s.type !== 'meta'))
    .map((s) => ({ name: s.name, type: s.type, score: scoreSkillForQuery(s.descTerms, q) }))
    .sort((a, b) => b.score - a.score);
}
