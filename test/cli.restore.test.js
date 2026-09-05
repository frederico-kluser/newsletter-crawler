// `ncrawl restore` e `ncrawl backup` pela CLI REAL (argv -> parseFlags -> dispatch), numa SANDBOX
// git descartável (test/helpers/cli-sandbox.js). O repo e o NC_HOME do usuário nunca são tocados.
//
// O que precisa valer:
//   - `restore --dry-run` diz o que faria e NÃO escreve NADA;
//   - `restore` sobre base VIVA é ação séria: exige --yes e faz BACKUP antes (sem backup, aborta);
//   - `--limit`, `--body-policy` (inválida = erro de uso, não silêncio) e `--no-marker` funcionam;
//   - `--no-marker` é a escotilha real: depois de um `reset` o marcador barra o restore de
//     propósito, e só ele ressuscita o acervo apagado sem querer;
//   - `backup` / `backup list` / `backup restore <arquivo|latest|best> --yes` fecham o ciclo, e a
//     reposição APAGA os sidecars `-wal`/`-shm` antes de copiar (um `-wal` sobrevivente é
//     reaplicado por cima do arquivo restaurado e o usuário volta ao banco velho);
//   - o `reset` AVISA que mexe no repositório git em ROOT (a raiz do CÓDIGO, não o cwd).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { cleanup, commitSnapshot, makeSandbox, runCli, snapRow } from './helpers/cli-sandbox.js';

const trash = [];
after(() => cleanup(trash));

/** Sandbox com histórico: snapshot antigo (1..4) + snapshot novo (1..3). União = 4. */
function novaSandbox(prefix) {
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

const artigos = (box) => {
  const r = runCli(box, ['status', '--no-restore']);
  const m = r.out.match(/articles:\s+(\d+)/);
  return m ? Number(m[1]) : null;
};
const backupsDe = (box) => {
  const dir = path.join(box.home, 'backups');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.db')) : [];
};

// ---- restore ----

test('restore --dry-run: mostra o que faria e NÃO escreve nada', () => {
  const box = novaSandbox('nc-rst-dry-');
  const r = runCli(box, ['restore', '--dry-run']);
  assert.equal(r.status, 0, `falhou: ${r.out}`);
  assert.match(r.out, /\[dry-run\] histórico: 2 commit\(s\) de dados/);
  assert.match(r.out, /\[dry-run\] união: 4 artigo\(s\) únicos/);
  assert.match(r.out, /\[dry-run\] selecionados: 4 — 3 manteriam o id do snapshot, 1 ganhariam id novo/);
  assert.match(r.out, /\[dry-run\] NADA foi escrito no banco/);
  assert.ok(!/aplicado:/.test(r.out), 'nenhum relatório de aplicação');
  assert.equal(artigos(box), 0, 'a base continua VAZIA depois do dry-run');
});

test('restore: reconstrói o acervo do histórico (base vazia dispensa --yes)', () => {
  const box = novaSandbox('nc-rst-ok-');
  const r = runCli(box, ['restore']);
  assert.equal(r.status, 0, `falhou: ${r.out}`);
  assert.match(r.out, /aplicado: 4 artigo\(s\) repostos/);
  assert.match(r.out, /base: 0 → 4 artigo\(s\)/);
  assert.equal(artigos(box), 4);
});

test('restore --limit N: respeita o teto', () => {
  const box = novaSandbox('nc-rst-limit-');
  const r = runCli(box, ['restore', '--limit', '2']);
  assert.equal(r.status, 0, `falhou: ${r.out}`);
  assert.match(r.out, /selecionados: 2 —/);
  assert.equal(artigos(box), 2);
});

test('restore --body-policy inválida: erro de uso, não silêncio', () => {
  const box = novaSandbox('nc-rst-policy-');
  const r = runCli(box, ['restore', '--body-policy', 'xpto']);
  assert.equal(r.status, 1);
  assert.match(r.out, /--body-policy inválida \("xpto"\) — use best \| first \| longest/);
  assert.equal(artigos(box), 0);
});

test('restore SOBRE BASE VIVA: sem --yes aborta e não toca em nada; com --yes faz BACKUP antes', () => {
  const box = novaSandbox('nc-rst-viva-');
  assert.equal(runCli(box, ['restore']).status, 0);
  assert.equal(artigos(box), 4, 'base viva');
  assert.equal(backupsDe(box).length, 0, 'nenhum backup ainda');

  const sem = runCli(box, ['restore']);
  assert.equal(sem.status, 1, 'base não-vazia exige confirmação');
  assert.match(sem.out, /restore SOBRE BASE VIVA: já há 4 artigo\(s\)/);
  assert.match(sem.out, /Confirme com:\s+ncrawl restore --yes/);
  assert.equal(backupsDe(box).length, 0, 'a recusa não cria backup nem escreve');

  const com = runCli(box, ['restore', '--yes']);
  assert.equal(com.status, 0, `falhou: ${com.out}`);
  assert.match(com.out, /BACKUP FEITO ANTES DE APAGAR/, 'backup obrigatório antes de escrever por cima');
  assert.equal(backupsDe(box).length, 1, 'a cópia existe no disco');
  assert.equal(artigos(box), 4, 'idempotente: a 2ª passada não duplica');
});

test('depois de um reset o marcador BARRA o restore — e --no-marker é a escotilha que ressuscita', () => {
  const box = novaSandbox('nc-rst-marker-');
  assert.equal(runCli(box, ['restore']).status, 0);
  assert.equal(artigos(box), 4);

  const reset = runCli(box, ['reset', '--yes', '--confirm', '4']);
  assert.equal(reset.status, 0, `reset falhou: ${reset.out}`);
  assert.equal(artigos(box), 0, 'o reset apagou');

  // O bootstrap NÃO pode ressuscitar o que o usuário mandou apagar.
  const status = runCli(box, ['status']);
  assert.equal(artigos(box), 0, 'o bootstrap respeita a fronteira do wipe');
  assert.match(status.out, /restore automático não rodou: nenhum snapshot no histórico/);

  // …mas quem apagou SEM QUERER tem como voltar.
  const volta = runCli(box, ['restore', '--no-marker']);
  assert.equal(volta.status, 0, `falhou: ${volta.out}`);
  assert.match(volta.out, /--no-marker: a fronteira do wipe foi IGNORADA/);
  assert.equal(artigos(box), 4, 'acervo de volta');
});

test('reset AVISA que mexe no repositório git em ROOT (o gesto é barato demais para o estrago)', () => {
  const box = novaSandbox('nc-rst-aviso-');
  assert.equal(runCli(box, ['restore']).status, 0);
  const r = runCli(box, ['reset', '--yes', '--confirm', '4']);
  assert.equal(r.status, 0, `falhou: ${r.out}`);
  assert.match(r.out, /reset também MEXE NO REPOSITÓRIO GIT em/, 'diz que mexe no git');
  assert.ok(r.out.includes(box.dir), 'e diz QUAL diretório (a raiz do CÓDIGO)');
  assert.match(r.out, /webapp\/public\/data/, 'nomeia o snapshot do site');
  assert.match(r.out, /ncrawl backup restore latest --yes/, 'e como desfazer');
});

test('reset sem --confirm <nº de artigos> é RECUSADO (o --yes sozinho é reflexo)', () => {
  const box = novaSandbox('nc-rst-confirm-');
  assert.equal(runCli(box, ['restore']).status, 0);
  const r = runCli(box, ['reset', '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.out, /Confirme com:\s+npm run reset -- --yes --confirm 4/);
  assert.equal(artigos(box), 4, 'nada foi apagado');
});

// ---- backup ----

test('backup numa base SEM DADO: diz que não havia o que copiar e sai 0 (não é falha)', () => {
  const box = novaSandbox('nc-bkp-vazio-');
  const r = runCli(box, ['backup']);
  assert.equal(r.status, 0, `base vazia não é erro de backup: ${r.out}`);
  assert.match(r.out, /não tem dado nenhum — não havia o que copiar/);
  assert.equal(backupsDe(box).length, 0);
});

test('backup / backup list / backup restore: ciclo completo, com os sidecars -wal/-shm apagados', () => {
  const box = novaSandbox('nc-bkp-ciclo-');
  assert.equal(runCli(box, ['restore']).status, 0);
  assert.equal(artigos(box), 4);

  const vazio = runCli(box, ['backup', 'list']);
  assert.equal(vazio.status, 0);
  assert.match(vazio.out, /nenhum backup em .*backups\./);

  const criar = runCli(box, ['backup']);
  assert.equal(criar.status, 0, `falhou: ${criar.out}`);
  assert.match(criar.out, /backup \(manual\): .*crawler-\d{8}T\d{6}Z-manual\.db — 4 artigos/);
  assert.match(criar.out, /para repor esta cópia depois:\s+ncrawl backup restore crawler-.*--yes/);
  const nome = criar.out.match(/(crawler-\d{8}T\d{6}Z-manual(?:-\d+)?\.db)/)[1];

  const lista = runCli(box, ['backup', 'list']);
  assert.equal(lista.status, 0);
  assert.match(lista.out, /1 backup\(s\) em .*backups \(do mais novo ao mais antigo\)/);
  assert.match(lista.out, new RegExp(`${nome}\\s+4 artigo\\(s\\)\\s+\\d+ KB\\s+\\d{4}-`), 'nº de artigos, tamanho e data');

  // Destrói de propósito (é o acidente do usuário) e repõe a partir da cópia.
  assert.equal(runCli(box, ['reset', '--yes', '--confirm', '4']).status, 0);
  assert.equal(artigos(box), 0);

  // Um `-wal` VELHO plantado à mão: se a reposição não o apagasse, o SQLite o reaplicaria por
  // cima do arquivo copiado no próximo open.
  const wal = path.join(box.home, 'crawler.db-wal');
  writeFileSync(wal, 'lixo de wal antigo');
  assert.ok(existsSync(wal));

  const repor = runCli(box, ['backup', 'restore', nome, '--yes']);
  assert.equal(repor.status, 0, `falhou: ${repor.out}`);
  assert.match(repor.out, /banco reposto de .*4 artigo\(s\)/);
  assert.ok(!existsSync(wal), 'o -wal remanescente foi APAGADO antes da cópia');
  assert.ok(!existsSync(path.join(box.home, 'crawler.db-shm')), 'o -shm também');
  assert.equal(artigos(box), 4, 'o acervo voltou do arquivo de backup');
});

test('backup restore latest --yes também funciona (e o banco atual vira backup antes)', () => {
  const box = novaSandbox('nc-bkp-latest-');
  assert.equal(runCli(box, ['restore']).status, 0);
  assert.equal(runCli(box, ['backup']).status, 0);
  assert.equal(runCli(box, ['reset', '--yes', '--confirm', '4']).status, 0);

  const r = runCli(box, ['backup', 'restore', 'latest', '--yes']);
  assert.equal(r.status, 0, `falhou: ${r.out}`);
  assert.equal(artigos(box), 4);
});

test('backup restore: sem --yes recusa; arquivo inexistente recusa; nada é tocado', () => {
  const box = novaSandbox('nc-bkp-recusa-');
  assert.equal(runCli(box, ['restore']).status, 0);
  assert.equal(runCli(box, ['backup']).status, 0);

  const sem = runCli(box, ['backup', 'restore', 'latest']);
  assert.equal(sem.status, 1);
  assert.match(sem.out, /backup restore SUBSTITUI .*crawler\.db \(4 artigo\(s\) agora\)/);
  assert.match(sem.out, /Confirme com:\s+ncrawl backup restore latest --yes/);

  const nao = runCli(box, ['backup', 'restore', 'nao-existe.db', '--yes']);
  assert.equal(nao.status, 1);
  assert.match(nao.out, /backup não encontrado: "nao-existe\.db"/);
  assert.match(nao.out, /ncrawl backup list/);

  assert.equal(artigos(box), 4, 'as recusas não mexeram no banco');
});

test('backup: subcomando desconhecido é erro de uso com a lista de formas válidas', () => {
  const box = novaSandbox('nc-bkp-sub-');
  const r = runCli(box, ['backup', 'xpto']);
  assert.equal(r.status, 1);
  assert.match(r.out, /subcomando desconhecido "xpto" \(use: backup \| backup list \| backup restore/);
});

test('restore e backup estão no help e em KNOWN_COMMANDS (senão a CLI diz "comando desconhecido")', () => {
  const box = novaSandbox('nc-bkp-help-');
  const help = runCli(box, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.out, /node src\/index\.js restore \[--dry-run\]/);
  assert.match(help.out, /node src\/index\.js backup \[list \| restore <arquivo\|latest\|best> --yes\]/);
  assert.match(help.out, /reset --yes --confirm <nº de artigos>/);
  assert.match(help.out, /--force --yes: RE-PROCESSA o acervo INTEIRO/);
  assert.match(help.out, /--allow-shrink publica um snapshot MENOR que o no ar/);
  assert.match(help.out, /MEXE NO REPOSITÓRIO GIT em ROOT/);
  assert.ok(!/comando desconhecido/.test(runCli(box, ['restore', '--dry-run']).out));
  assert.ok(!/comando desconhecido/.test(runCli(box, ['backup', 'list']).out));
});
