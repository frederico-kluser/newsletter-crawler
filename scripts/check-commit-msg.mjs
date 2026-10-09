#!/usr/bin/env node
// Gate 1 (opensource-project): valida a mensagem de commit contra Conventional Commits.
// Zero deps de propósito (repo puro ESM, sem build): o hook corre em qualquer clone
// logo a seguir ao `npm install` (postinstall aponta core.hooksPath para .githooks).
// Uso: node scripts/check-commit-msg.mjs <ficheiro-da-mensagem>   (o hook passa "$1")
import { readFileSync } from 'node:fs';

const CONV = /^(feat|fix|docs|chore|test|refactor|perf|build|ci|style|revert)(\([^)]+\))?!?: .+/;
const ISENTAS = /^(Merge |Revert |fixup! |squash! )/; // convenção do git, fora do gate

const file = process.argv[2];
if (!file) {
  console.error('uso: check-commit-msg.mjs <ficheiro-da-mensagem>');
  process.exit(2);
}
let msg;
try {
  msg = readFileSync(file, 'utf8');
} catch {
  console.error(`check-commit-msg: não consegui ler ${file}`);
  process.exit(2);
}

const subject = (msg.split('\n')[0] ?? '').trim();
if (ISENTAS.test(subject)) process.exit(0);

const erros = [];
if (!CONV.test(subject)) {
  erros.push(
    'a 1ª linha precisa de ser Conventional Commits: tipo(escopo): descrição ' +
      '(tipos: feat|fix|docs|chore|test|refactor|perf|build|ci|style|revert)',
  );
}
if (subject.length > 72) erros.push(`a 1ª linha tem ${subject.length} chars (máx. 72)`);
const lines = msg.split('\n');
if (lines.length > 1 && lines[1].trim() !== '' && !ISENTAS.test(subject)) {
  erros.push('a 2ª linha precisa de estar em branco (antes do corpo)');
}
if (erros.length) {
  console.error(
    `check-commit-msg: mensagem inválida:\n${erros.map((e) => `  - ${e}`).join('\n')}\n\n` +
      'Exemplo: fix(crawl): corrige o piso de data por fonte\n' +
      'Detalhes: CONTRIBUTING.md (Commits Convencionais)',
  );
  process.exit(1);
}
