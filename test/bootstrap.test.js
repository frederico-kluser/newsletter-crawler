// BOOTSTRAP — o pedido LITERAL do usuário: "quero que nunca recomece do zero (…) qualquer projeto
// que clonar esse e quiser pegar dados por padrão já recupera todos os dados que tem no git".
//
// O que este arquivo prova, sobre uma SANDBOX (repositório git descartável que é ele mesmo a raiz
// do código — ver test/helpers/cli-sandbox.js), com a CLI REAL em subprocesso (argv -> parseFlags
// -> dispatch), NUNCA sobre o repo nem o NC_HOME do usuário:
//   - base VAZIA + snapshot no histórico ⇒ o primeiro comando útil (`status`) traz o acervo de
//     volta sozinho, avisando ANTES de começar (12s de silêncio parecem travamento);
//   - a UNIÃO do histórico é maior que o snapshot mais novo (é o motivo de o restore existir);
//   - base CHEIA ⇒ o bootstrap não faz NADA, e em silêncio (repetir "a base já tem artigos" em
//     todo comando seria ruído);
//   - `--no-restore` e `CRAWLER_AUTO_RESTORE=false` desligam, e DIZEM que desligaram;
//   - sob a suíte de testes (NODE_TEST_CONTEXT) o bootstrap JAMAIS dispara — sem isso os 40+
//     bancos temporários da suíte seriam populados com 15 mil artigos;
//   - comando FORA da allowlist (`limits`) não dispara — e `reset` não está lá de propósito;
//   - o caminho `ui` é coberto pela mesma allowlist (o menu mostra o status no 1º quadro);
//   - clone RASO (--depth 1) degrada com AVISO em vez de falhar.
//
// Este arquivo NÃO importa nada de src/: tudo acontece em processos filhos com NC_HOME próprio.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, cloneSandbox, commitSnapshot, makeSandbox, runCli, snapRow } from './helpers/cli-sandbox.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const trash = [];
after(() => cleanup(trash));

/** Sandbox com DOIS snapshots: o antigo tem 1..4, o novo só 1..3 (o 4 sumiu num wipe). A união
 *  são 4 artigos — é o cenário que faz "restaurar do histórico" valer mais que "copiar o último". */
function sandboxComHistorico(prefix) {
  const box = makeSandbox(prefix);
  trash.push(box.dir, box.home);
  commitSnapshot(box.dir, {
    generatedAt: '2026-01-02T00:00:00.000Z',
    articles: [1, 2, 3, 4].map((i) => snapRow(i, `https://ex.test/a${i}`)),
    message: 'chore(data): snapshot antigo',
  });
  commitSnapshot(box.dir, {
    generatedAt: '2026-02-02T00:00:00.000Z',
    articles: [1, 2, 3].map((i) => snapRow(i, `https://ex.test/a${i}`)),
    message: 'chore(data): snapshot novo',
  });
  return box;
}

const artigosNoStatus = (out) => {
  const m = out.match(/articles:\s+(\d+)/);
  return m ? Number(m[1]) : null;
};

test('base VAZIA + histórico no git: `status` restaura o acervo SOZINHO (a união dos snapshots)', () => {
  const box = sandboxComHistorico('nc-boot-ok-');
  const r = runCli(box, ['status']);
  assert.equal(r.status, 0, `status falhou: ${r.out}`);
  assert.match(r.out, /base VAZIA — procurando o acervo no histórico do git/, 'avisa ANTES da varredura');
  assert.match(r.out, /base vazia \+ snapshot no git: restaurando 4 artigos/, 'a UNIÃO (4), não o último snapshot (3)');
  assert.match(r.out, /restore: 4 artigos repostos/);
  assert.equal(artigosNoStatus(r.out), 4, 'o status já reflete a base restaurada');
});

test('base CHEIA: o bootstrap não faz nada — e não diz nada (a 2ª execução é limpa)', () => {
  const box = sandboxComHistorico('nc-boot-cheia-');
  const first = runCli(box, ['status']);
  assert.equal(artigosNoStatus(first.out), 4);

  const second = runCli(box, ['status']);
  assert.equal(second.status, 0, `2ª execução falhou: ${second.out}`);
  assert.equal(artigosNoStatus(second.out), 4, 'nada foi duplicado nem re-restaurado');
  assert.ok(!/procurando o acervo no histórico/.test(second.out), 'não varre o git de novo');
  assert.ok(!/restore: \d+ artigos repostos/.test(second.out), 'não restaura de novo');
  assert.ok(!/restore automático não rodou/.test(second.out), 'e o pulo é SILENCIOSO na base cheia');
});

test('--no-restore desliga o bootstrap (e diz que desligou)', () => {
  const box = sandboxComHistorico('nc-boot-flag-');
  const r = runCli(box, ['status', '--no-restore']);
  assert.equal(r.status, 0, `falhou: ${r.out}`);
  assert.equal(artigosNoStatus(r.out), 0, 'a base continua vazia');
  assert.match(r.out, /restore automático não rodou: desligado \(CRAWLER_AUTO_RESTORE=false ou --no-restore\)/);
});

test('CRAWLER_AUTO_RESTORE=false desliga o bootstrap', () => {
  const box = sandboxComHistorico('nc-boot-env-');
  const r = runCli(box, ['status'], { env: { CRAWLER_AUTO_RESTORE: 'false' } });
  assert.equal(r.status, 0, `falhou: ${r.out}`);
  assert.equal(artigosNoStatus(r.out), 0, 'a base continua vazia');
  assert.match(r.out, /restore automático não rodou: desligado/);
});

test('sob a suíte de testes (NODE_TEST_CONTEXT) o bootstrap JAMAIS dispara', () => {
  const box = sandboxComHistorico('nc-boot-test-');
  // allowBootstrap:false = o NODE_TEST_CONTEXT do runner CHEGA ao filho (é o que acontece hoje em
  // todo spawnSync da suíte). A base tem de continuar vazia.
  const r = runCli(box, ['status'], { allowBootstrap: false });
  assert.equal(r.status, 0, `falhou: ${r.out}`);
  assert.equal(artigosNoStatus(r.out), 0, 'nenhum artigo escapou para o banco temporário do teste');
  assert.match(r.out, /restore automático não rodou: processo sob a suíte de testes/);
});

test('NC_NO_AUTO_RESTORE=1 desliga com motivo PRÓPRIO (escotilha independente da flag)', () => {
  const box = sandboxComHistorico('nc-boot-envhatch-');
  const r = runCli(box, ['status'], { env: { NC_NO_AUTO_RESTORE: '1' } });
  assert.equal(artigosNoStatus(r.out), 0);
  assert.match(r.out, /restore automático não rodou: desligado por NC_NO_AUTO_RESTORE=1/);
});

test('comando FORA da allowlist (limits) não dispara o bootstrap', () => {
  const box = sandboxComHistorico('nc-boot-allow-');
  const r = runCli(box, ['limits', 'show']);
  assert.equal(r.status, 0, `falhou: ${r.out}`);
  assert.ok(!/procurando o acervo no histórico/.test(r.out), 'limits não varre o git');
  assert.ok(!/restore: \d+ artigos repostos/.test(r.out), 'limits não restaura');
  const depois = runCli(box, ['status'], { env: { CRAWLER_AUTO_RESTORE: 'false' } });
  assert.equal(artigosNoStatus(depois.out), 0, 'a base seguiu vazia depois do limits');
});

test('a allowlist do bootstrap é a acordada — e reset/purge/remove/key/add/deploy/export estão FORA', () => {
  // Lida do FONTE (sem importar src/: importar cli-restore.js aqui abriria config/db).
  const src = readFileSync(path.join(REPO, 'src', 'cli-restore.js'), 'utf8');
  const m = src.match(/export const BOOTSTRAP_COMMANDS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'BOOTSTRAP_COMMANDS declarado como um Set literal');
  const cmds = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(
    [...cmds].sort(),
    ['crawl', 'finish', 'menu', 'search', 'status', 'ui', 'web'],
    'allowlist exata',
  );
  for (const proibido of ['reset', 'clean', 'purge', 'remove', 'key', 'limits', 'add', 'deploy', 'inspect', 'export']) {
    assert.ok(!cmds.includes(proibido), `${proibido} NUNCA pode disparar o bootstrap`);
  }
});

test('o caminho `ui` também recupera: o gancho está ANTES do render da TUI', () => {
  // A TUI exige TTY, então o e2e do menu não cabe aqui. O que É verificável e é o que quebra na
  // prática: (a) 'ui'/'menu' estão na allowlist; (b) o index.js chama o bootstrap no ramo da UI
  // ANTES de importar ./ui/index.js — a TUI mostra o status já no primeiro quadro.
  const idx = readFileSync(path.join(REPO, 'src', 'index.js'), 'utf8');
  const chamada = idx.indexOf("bootstrapFromCli('ui', flags)");
  const render = idx.indexOf("await import('./ui/index.js')");
  assert.ok(chamada > 0, 'o ramo da UI chama bootstrapFromCli');
  assert.ok(render > 0 && chamada < render, 'o bootstrap vem ANTES do import/render da TUI');
  const src = readFileSync(path.join(REPO, 'src', 'cli-restore.js'), 'utf8');
  assert.match(src, /BOOTSTRAP_COMMANDS = new Set\(\[[^\]]*'ui'/, "'ui' na allowlist");
});

test('clone RASO (--depth 1): degrada com AVISO e ainda traz o working tree, sem falhar', () => {
  const box = sandboxComHistorico('nc-boot-shallow-');
  const raso = cloneSandbox(box, { depth: 1, prefix: 'nc-boot-shallow-clone-' });
  trash.push(raso.dir, raso.home);
  const r = runCli(raso, ['status']);
  assert.equal(r.status, 0, `o clone raso NÃO pode derrubar o comando: ${r.out}`);
  assert.match(r.out, /clone RASO \(--depth 1\)/, 'avisa que o histórico não veio');
  assert.match(r.out, /git fetch --unshallow/, 'e diz como consertar');
  // Só o snapshot do working tree (3), não a união do histórico (4) — a degradação é essa.
  assert.equal(artigosNoStatus(r.out), 3, 'restaurou o que dava: o snapshot do working tree');
});

test('clone COMPLETO de outro projeto: o acervo inteiro vem junto, sem nenhum comando extra', () => {
  const box = sandboxComHistorico('nc-boot-clone-');
  const clone = cloneSandbox(box, { prefix: 'nc-boot-clone-full-' });
  trash.push(clone.dir, clone.home);
  const r = runCli(clone, ['status']);
  assert.equal(r.status, 0, `falhou: ${r.out}`);
  assert.equal(artigosNoStatus(r.out), 4, 'o clone recupera a UNIÃO do histórico (o pedido do usuário)');
});
