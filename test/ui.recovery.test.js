// Telas de BACKUP e RECUPERAR da TUI. Componentes PUROS (lista e efeitos por props) → nenhum DB,
// nenhum NC_HOME aqui. O que precisa ficar fixado:
//   - a lista de backups mostra o nº de ARTIGOS de cada cópia (sem ele, dois nomes de arquivo são
//     indistinguíveis e a escolha deixa de ser auditável);
//   - "mais recente" (latestBackup) e "mais completo" (bestBackup) são NOMEADOS separadamente,
//     porque divergem — escolher errado é perder acervo de novo;
//   - repor um arquivo FECHA a conexão do SQLite: o desfecho só oferece SAIR;
//   - o caminho do git avisa que a varredura é lenta e SÍNCRONA antes de rodar.
process.env.CRAWLER_LANG = ''; // asserts em PT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { keys, wait, waitForFrame } from './helpers/ink.js';

const { html } = await import('../src/ui/html.js');
const { BackupView } = await import('../src/ui/BackupView.js');
const { RestoreView } = await import('../src/ui/RestoreView.js');

const BACKUPS = [
  { name: 'crawler-20260901-031600-reset.db', path: '/bk/crawler-20260901-031600-reset.db', bytes: 5 * 1048576, mtime: new Date('2026-09-01T03:16:00Z'), articles: 12, reason: 'reset' },
  { name: 'crawler-20260831-120000-crawl.db', path: '/bk/crawler-20260831-120000-crawl.db', bytes: 90 * 1048576, mtime: new Date('2026-08-31T12:00:00Z'), articles: 3249, reason: 'crawl' },
  { name: 'crawler-20260830-090000-manual.db', path: '/bk/crawler-20260830-090000-manual.db', bytes: 1024, mtime: new Date('2026-08-30T09:00:00Z'), articles: null, reason: 'manual' },
];

test('Backup: lista nome, nº de artigos, tamanho e data de cada cópia', async () => {
  const { lastFrame, unmount } = render(
    html`<${BackupView} backups=${BACKUPS} dir="/bk" onCreate=${() => ({ ok: true })} onDone=${() => {}} />`,
  );
  await wait(40);
  const f = lastFrame() || '';
  assert.ok(f.includes('3 cópia(s) em /bk'), `cabeçalho com a contagem e o diretório\n${f}`);
  assert.ok(f.includes('crawler-20260831-120000-crawl.db'), `nome do arquivo\n${f}`);
  assert.ok(/3249 artigos/.test(f), `nº de artigos por cópia\n${f}`);
  assert.ok(/90\.0 MB/.test(f), `tamanho\n${f}`);
  assert.ok(f.includes('2026-08-31 12:00'), `data\n${f}`);
  assert.ok(f.includes('ILEGÍVEL'), `cópia que não abre continua VISÍVEL, marcada\n${f}`);
  assert.ok(f.includes('Fazer backup agora'), `a ação de criar\n${f}`);
  unmount();
});

test('Backup: "Fazer backup agora" chama o onCreate e anuncia a cópia nova', async () => {
  let calls = 0;
  const { stdin, lastFrame, unmount } = render(
    html`<${BackupView}
      backups=${[]}
      dir="/bk"
      onCreate=${() => {
        calls += 1;
        return { ok: true, reason: 'created', backup: { name: 'crawler-20260905-manual.db', articles: 42, bytes: 2048, mtime: new Date('2026-09-05T10:00:00Z'), reason: 'manual' } };
      }}
      onDone=${() => {}}
    />`,
  );
  await wait(40);
  assert.ok((lastFrame() || '').includes('Nenhum backup ainda'), 'estado vazio');
  stdin.write(keys.ENTER); // 1ª opção = Fazer backup agora
  const f = await waitForFrame(lastFrame, (x) => x.includes('backup criado'));
  assert.equal(calls, 1);
  assert.ok(f.includes('crawler-20260905-manual.db'));
  assert.ok(/42 artigo/.test(f));
  assert.ok(f.includes('1 cópia(s) em /bk'), `a cópia nova entra na lista\n${f}`);
  unmount();
});

test('Backup: banco sem dado nenhum não é erro ("não havia o que copiar")', async () => {
  const { stdin, lastFrame, unmount } = render(
    html`<${BackupView} backups=${[]} dir="/bk" onCreate=${() => ({ ok: true, reason: 'empty', backup: null })} onDone=${() => {}} />`,
  );
  await wait(40);
  stdin.write(keys.ENTER);
  const f = await waitForFrame(lastFrame, (x) => x.includes('não havia o que copiar'));
  assert.ok(f.includes('não havia o que copiar'));
  unmount();
});

function mountRestore(over = {}) {
  const calls = { git: [], file: [], done: [] };
  const r = render(
    html`<${RestoreView}
      articles=${over.articles ?? 851}
      backups=${over.backups ?? BACKUPS}
      latest=${over.latest ?? BACKUPS[0]}
      best=${over.best ?? BACKUPS[1]}
      dir="/bk"
      root="/repo"
      hasGit=${over.hasGit ?? true}
      onRunGit=${(flags) => calls.git.push(flags)}
      onRestoreFile=${(pick) => {
        calls.file.push(pick.name);
        return over.fileResult ?? { ok: true, name: pick.name, articles: pick.articles };
      }}
      onDone=${(v) => calls.done.push(v)}
    />`,
  );
  return { ...r, calls };
}

test('Recuperar: oferece as DUAS origens (git e arquivo de backup)', async () => {
  const { lastFrame, unmount } = mountRestore();
  await wait(40);
  const f = lastFrame() || '';
  assert.ok(f.includes('De onde recuperar?'), f);
  assert.ok(f.includes('histórico do git'), f);
  assert.ok(f.includes('arquivo de backup'), f);
  unmount();
});

test('Recuperar do git: avisa que leva ~10s e é síncrono, e que a base não está vazia', async () => {
  const { stdin, lastFrame, calls, unmount } = mountRestore();
  await wait(40);
  stdin.write(keys.ENTER); // 1ª origem = git
  const f = await waitForFrame(lastFrame, (x) => x.includes('~10s'));
  assert.ok(/SÍNCRONA/.test(f), `o aviso de "parece travamento" tem que estar ANTES\n${f}`);
  assert.ok(/851 artigo/.test(f), `base viva: o restore REPÕE, e isso é dito\n${f}`);
  stdin.write(keys.DOWN); // "Restaurar de verdade" (a 1ª é a simulação)
  await wait(30);
  stdin.write(keys.ENTER);
  await wait(60);
  assert.deepEqual(calls.git, [{ yes: true }]);
  unmount();
});

test('Recuperar do git: sem repositório, a tela diz e não deixa seguir', async () => {
  const { stdin, lastFrame, calls, unmount } = mountRestore({ hasGit: false });
  await wait(40);
  stdin.write(keys.ENTER);
  const f = await waitForFrame(lastFrame, (x) => x.includes('não é um repositório git'));
  assert.ok(f.includes('/repo'), f);
  assert.deepEqual(calls.git, []);
  unmount();
});

test('Recuperar de arquivo: "mais recente" e "mais completo" aparecem NOMEADOS e com contagem', async () => {
  const { stdin, lastFrame, unmount } = mountRestore();
  await wait(40);
  stdin.write(keys.DOWN); // 2ª origem = arquivo de backup
  await wait(30);
  stdin.write(keys.ENTER);
  const f = await waitForFrame(lastFrame, (x) => x.includes('Qual cópia repor?'));
  assert.ok(/Mais recente — volta ao ESTADO ANTERIOR/.test(f), f);
  assert.ok(/12 artigo/.test(f), `contagem da mais recente\n${f}`);
  assert.ok(/mais COMPLETO/.test(f), f);
  assert.ok(/3249 artigo/.test(f), `contagem da mais completa\n${f}`);
  assert.ok(f.includes('cópias DIFERENTES'), `a divergência entre as duas é dita\n${f}`);
  unmount();
});

test('Recuperar de arquivo: confirma, repõe e EXIGE sair (a conexão foi fechada)', async () => {
  const { stdin, lastFrame, calls, unmount } = mountRestore();
  await wait(40);
  stdin.write(keys.DOWN);
  await wait(30);
  stdin.write(keys.ENTER); // origem = arquivo
  await waitForFrame(lastFrame, (x) => x.includes('Qual cópia repor?'));
  stdin.write(keys.DOWN); // 2ª = a mais COMPLETA (3249)
  await wait(30);
  stdin.write(keys.ENTER);
  const conf = await waitForFrame(lastFrame, (x) => x.includes('por cima do banco atual'));
  assert.ok(/3249 artigo/.test(conf), conf);
  assert.ok(/\(851/.test(conf), `mostra o que existe hoje (o Alert quebra a linha)\n${conf}`);
  assert.ok(conf.includes('ncrawl backup restore'), `ensina o comando equivalente\n${conf}`);
  assert.deepEqual(calls.file, [], 'a confirmação não repõe sozinha');

  stdin.write(keys.DOWN); // "Repor esta cópia" (a 1ª é Cancelar)
  await wait(30);
  stdin.write(keys.ENTER);
  const done = await waitForFrame(lastFrame, (x) => x.includes('Banco reposto'));
  assert.deepEqual(calls.file, ['crawler-20260831-120000-crawl.db']);
  assert.ok(done.includes('FECHADA'), `o usuário PRECISA saber que tem que reabrir\n${done}`);
  assert.ok(done.includes('Sair (obrigatório)'), `a única saída é sair\n${done}`);
  assert.ok(!done.includes('Voltar ao menu'), `não pode voltar ao menu com o banco fechado\n${done}`);
  stdin.write(keys.ENTER);
  await wait(60);
  assert.deepEqual(calls.done, ['quit']);
  unmount();
});

test('Recuperar de arquivo: cópia ILEGÍVEL nunca vira reposição', async () => {
  const { stdin, lastFrame, calls, unmount } = mountRestore({ latest: BACKUPS[2], best: BACKUPS[1] });
  await wait(40);
  stdin.write(keys.DOWN);
  await wait(30);
  stdin.write(keys.ENTER);
  await waitForFrame(lastFrame, (x) => x.includes('Qual cópia repor?'));
  stdin.write(keys.ENTER); // 1ª = a "mais recente", que aqui é a ilegível
  const f = await waitForFrame(lastFrame, (x) => x.includes('Falha ao repor'));
  assert.deepEqual(calls.file, [], 'não se repõe um arquivo que não abre');
  assert.ok(f.includes('ILEGÍVEL'), f);
  unmount();
});

test('Recuperar de arquivo: sem nenhuma cópia, manda fazer uma', async () => {
  const { stdin, lastFrame, unmount } = mountRestore({ backups: [], latest: null, best: null });
  await wait(40);
  stdin.write(keys.DOWN);
  await wait(30);
  stdin.write(keys.ENTER);
  const f = await waitForFrame(lastFrame, (x) => x.includes('Nenhum backup em /bk'));
  assert.ok(f.includes('Backups do acervo'), f);
  unmount();
});
