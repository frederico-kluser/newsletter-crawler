#!/usr/bin/env node
// PreToolUse security guardrail (also fires for subagent tool calls). Blocks
// reading .env / secrets/** and clearly destructive Bash. Conservative by design
// to avoid false positives; fail-open on parse errors.
import { readFileSync } from 'node:fs';

const allow = () => process.exit(0);
const block = (m) => {
  console.error(m);
  process.exit(2);
};

let p = {};
try {
  p = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  allow();
}
const tool = p.tool_name || '';
const ti = p.tool_input || {};

if (tool === 'Read') {
  const fp = ti.file_path || ti.path || '';
  if (/(^|\/)\.env(\.[\w-]+)?$/.test(fp) && !/\.env\.example$/.test(fp)) block(`[security] reading .env is blocked: ${fp}`);
  if (/(^|\/)secrets\//.test(fp)) block(`[security] reading secrets/ is blocked: ${fp}`);
  allow();
}

if (tool === 'Bash') {
  const cmd = ti.command || '';
  const dangers = [
    { re: /\brm\s+-[a-z]*[rf][a-z]*\s+(?:-[a-z]+\s+)*(?:\/(?:\s|$|\*)|~(?:\/\s|\s|$)|\$HOME)/, m: 'rm -rf on / ~ or $HOME' },
    { re: /:\(\)\s*\{\s*:\s*\|\s*:/, m: 'fork bomb' },
    { re: /\bmkfs\b/, m: 'mkfs' },
    { re: /\bdd\s+if=/, m: 'dd if=' },
    { re: />\s*\/dev\/(?:sd|nvme|hd)\w/, m: 'overwrite block device' },
    { re: /\bgit\s+[^\n]*\b(?:filter-branch|filter-repo)\b/, m: 'git history rewrite' },
    { re: /\bgit\s+push\b[^\n]*(?:--force(?!-with-lease)\b|\s-f\b)/, m: 'git force push' },
    { re: /\bchmod\s+-R\s+777\s+\//, m: 'chmod -R 777 /' },
    { re: /\b(?:cat|less|more|head|tail|nl|xxd|od|strings|bat|cp|mv|scp)\b[^\n]*(?:^|\/|\s)\.env(?!\.example)\b/, m: 'reading/copying .env contents' },
  ];
  for (const d of dangers) if (d.re.test(cmd)) block(`[security] blocked (${d.m}): ${cmd.slice(0, 140)}`);
  allow();
}

allow();
