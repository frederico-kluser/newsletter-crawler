// O guard anti-encolhimento NO CAMINHO DO DEPLOY — e não só na função pura (isso é
// test/snapshot-guard.test.js). O incidente que dá origem a tudo (2026-08-24, commit 7c24491)
// aconteceu com a regra "óbvia" na mão: o deploy IMPRIMIU "export web: 0 artigos" e "site no ar:
// 2866 artigos" e publicou assim mesmo, porque nenhum dos dois números chegava a uma decisão. Por
// isso os testes aqui exercitam a ORQUESTRAÇÃO (`runDeploy`) de ponta a ponta, com git/export/site
// injetados: o defeito morava na sequência das etapas, não numa comparação isolada.
//
// Nada aqui toca repositório, rede ou banco: NC_HOME vai p/ um tmp ANTES dos imports (config.js
// cria o diretório e db.js resolve o DB_PATH no load) e os imports são DINÂMICOS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-deploy-guard-test-'));
process.env.NC_HOME = NC_HOME_TMP;
// Nenhum teste daqui usa a rede (fetchLive é injetado), mas o default aponta p/ o site REAL:
// deixar explícito que o alvo é inválido evita que um refactor futuro passe a sondar produção.
process.env.NC_SITE_URL = 'https://site.invalido.test';

const { runDeploy, guardSnapshot, restoreSnapshot, DeployError } = await import('../src/deploy.js');
const { setLogSink } = await import('../src/util.js');

// O parseFlags REAL da CLI, extraído do src/index.js (não é exportado, e importar o módulo
// dispararia o CLI). É a prova de que o opt-in citado nas mensagens funciona na linha de comando.
const parseFlags = (() => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const inicio = src.indexOf('function parseFlags(argv) {');
  const fim = src.indexOf('\n}\n', inicio);
  assert.ok(inicio >= 0 && fim > inicio, 'não achei function parseFlags(argv) em src/index.js');
  return new Function(`${src.slice(inicio, fim + 3)}\nreturn parseFlags;`)();
})();

// ---- costura: um git de mentira que responde ao argv e REGISTRA tudo ----

const RESTORE_CALL = 'restore -- webapp/public/data webapp/public/api/v1';
// A varredura dos diretórios (`git clean -fdq -- <dirs>`) NÃO pode voltar: ela apagava arquivo do
// usuário guardado no dir de dados. O que existe agora é uma remoção por nome, arquivo a arquivo.
const CLEAN_VARRIDA = 'clean -fdq';

/**
 * @param headArticles total no `HEAD:meta.json` (null = arquivo inexistente lá)
 * @param dataStatus   saída de `git status --porcelain -- <dirs>` (dado novo na árvore)
 * @param ahead/behind divergência com o origin
 */
function fakeGit({ headArticles = null, headStamp = 'HEAD-STAMP', ahead = 0, behind = 0, dataStatus = '', status = '' } = {}) {
  const calls = [];
  const headMeta = headArticles == null
    ? null
    : JSON.stringify({ schemaVersion: 1, generatedAt: headStamp, totals: { articles: headArticles } });
  const run = (args) => {
    calls.push(args.join(' '));
    const [cmd, sub] = args;
    if (cmd === 'rev-parse' && sub === '--show-toplevel') return '/repo-de-mentira';
    if (cmd === 'rev-parse' && sub === '--abbrev-ref') return 'main';
    if (cmd === 'rev-parse' && sub === '--short') return 'abc1234';
    if (cmd === 'rev-parse') return 'abc1234deadbeef';
    // Remote NÃO-github de propósito: `ensureGithubGitAuth` sai na hora e o teste nunca chega
    // perto de `which gh` nem de um `git config --global`.
    if (cmd === 'remote' && sub === 'get-url') return 'https://exemplo.invalido/repo.git';
    if (cmd === 'remote') return 'origin';
    if (cmd === 'status') return args.includes('--') ? dataStatus : status;
    if (cmd === 'fetch') return '';
    if (cmd === 'rev-list') return `${behind}\t${ahead}`;
    if (cmd === 'show') return headMeta;
    if (cmd === 'cat-file') return headMeta == null ? null : '';
    if (cmd === 'diff') return '';
    return '';
  };
  run.calls = calls;
  run.fez = (prefixo) => calls.some((c) => c.startsWith(prefixo));
  return run;
}

// Deps padrão: export/API/site injetados (nenhum I/O real).
function deps({ git, novo = 0, live = null, exportWeb = null }) {
  const vistos = { exportWeb: [] };
  const d = {
    git,
    exportWeb: exportWeb || ((opts) => { vistos.exportWeb.push(opts); return { articles: novo, bytes: 123 }; }),
    exportApi: () => ({ bytes: 45 }),
    fetchLive: async () => live,
  };
  d.vistos = vistos;
  return d;
}

// Captura os logs (e cala o console) durante um teste.
function capturaLogs(t) {
  const linhas = [];
  setLogSink(({ level, text }) => linhas.push(`${level}: ${text}`));
  t.after(() => setLogSink(null));
  return linhas;
}

const NO_AR_2866 = { generatedAt: 'G-ANTIGO', articles: 2866 };
const NO_AR_13758 = { generatedAt: 'G-ANTIGO', articles: 13758 };

// ---- Y1: o incidente, no caminho do deploy ----

test('7c24491 pelo DEPLOY: export de 0 artigos sobre 2866 no ar ABORTA antes de commitar', async (t) => {
  const linhas = capturaLogs(t);
  const git = fakeGit({ headArticles: 2866, dataStatus: ' M webapp/public/data/articles.json' });
  await assert.rejects(
    runDeploy({}, deps({ git, novo: 0, live: NO_AR_2866 })),
    (e) => {
      assert.ok(e instanceof DeployError, 'tem de ser DeployError (o CLI/TUI imprimem message+hint)');
      assert.match(e.message, /APAGARIA o acervo do site/);
      assert.match(e.message, /0 artigos/);
      assert.match(e.message, /2866/);
      assert.match(e.hint, /RESTAURE o banco/);
      assert.match(e.hint, /--allow-shrink wipe/);       // o opt-in citado é o que o parser aceita
      assert.equal(/--allow-shrink=/.test(e.hint), false); // ... e NUNCA a forma com `=`
      return true;
    },
  );
  // Nada de commit, nada de push: o acervo publicado fica onde está.
  assert.equal(git.fez('commit'), false);
  assert.equal(git.fez('push'), false);
  assert.equal(git.fez('add'), false);
  // E a árvore volta ao HEAD (senão o snapshot esvaziado esperaria o próximo `git add`).
  assert.ok(git.calls.includes(RESTORE_CALL));
  // O deploy ainda mostra os dois números — só que agora eles DECIDEM.
  assert.ok(linhas.some((l) => l.includes('site no ar: 2866 artigos')));
});

test('7c24491: o guard bloqueia mesmo com o site ilegível (o HEAD sozinho já é base)', async (t) => {
  capturaLogs(t);
  const git = fakeGit({ headArticles: 2866 });
  await assert.rejects(
    runDeploy({}, deps({ git, novo: 0, live: null })),
    (e) => e instanceof DeployError && /APAGARIA/.test(e.message),
  );
  assert.equal(git.fez('push'), false);
});

test('encolhimento parcial (2866 → 1200) também aborta o deploy', async (t) => {
  capturaLogs(t);
  const git = fakeGit({ headArticles: 2866, dataStatus: ' M webapp/public/data/articles.json' });
  await assert.rejects(
    runDeploy({}, deps({ git, novo: 1200, live: NO_AR_2866 })),
    (e) => e instanceof DeployError && /MENOS artigos/.test(e.message) && /1666/.test(e.message),
  );
  assert.equal(git.fez('push'), false);
});

test('o caminho normal (acervo cresceu) segue publicando como antes', async (t) => {
  const linhas = capturaLogs(t);
  const git = fakeGit({ headArticles: 2866, dataStatus: ' M webapp/public/data/articles.json' });
  const res = await runDeploy({ 'no-wait': true }, deps({ git, novo: 2900, live: NO_AR_2866 }));
  assert.equal(res.status, 'pushed');
  assert.equal(res.articles, 2900);
  assert.ok(git.fez('commit'));
  assert.ok(git.fez('push'));
  // Sem override: nenhum grito de ATENÇÃO no caminho feliz.
  assert.equal(linhas.some((l) => l.includes('ATENÇÃO')), false);
});

// ---- Y2: o commit-wipe JÁ CRIADO, barrado no push ----

test('commit-wipe já criado (novo=0, head=0, site 13758) não chega ao push — e o hint fala do COMMIT', async (t) => {
  capturaLogs(t);
  // Cenário real: um deploy anterior commitou o snapshot vazio; a base local continua vazia, então
  // não há dado novo p/ commitar — só o commit pendente, que o push publicaria.
  const git = fakeGit({ headArticles: 0, ahead: 1 });
  await assert.rejects(
    runDeploy({}, deps({ git, novo: 0, live: NO_AR_13758 })),
    (e) => {
      assert.ok(e instanceof DeployError);
      assert.match(e.message, /APAGARIA o acervo do site/);
      assert.match(e.message, /13758/);
      // O conselho que morava no guard de etapa `push` (inalcançável — ver hintHeadAbaixoDoAr)
      // chega aqui, no bloqueio que REALMENTE acontece: o problema também está no commit pendente.
      assert.match(e.hint, /JÁ ESTÁ COMMITADO no HEAD/);
      assert.match(e.hint, /git revert/);
      return true;
    },
  );
  assert.equal(git.fez('push'), false);
});

test('HEAD saudável não ganha o aviso de "corrija o commit" (o hint extra é condicional)', async (t) => {
  capturaLogs(t);
  // HEAD (2866) == site (2866): o commit pendente não é o problema, só a base local — dizer
  // "git revert" aqui mandaria o usuário desfazer um commit correto.
  const git = fakeGit({ headArticles: 2866 });
  await assert.rejects(
    runDeploy({}, deps({ git, novo: 0, live: NO_AR_2866 })),
    (e) => {
      assert.match(e.hint, /RESTAURE o banco/);
      assert.equal(/JÁ ESTÁ COMMITADO no HEAD/.test(e.hint), false);
      return true;
    },
  );
});

test('ramo `unpushed` saudável (HEAD == site) publica normalmente', async (t) => {
  capturaLogs(t);
  const git = fakeGit({ headArticles: 13758, ahead: 1 });
  const res = await runDeploy({ 'no-wait': true }, deps({ git, novo: 13758, live: NO_AR_13758 }));
  assert.equal(res.status, 'pushed');
  assert.equal(res.reason, 'unpushed');
});

// ---- Y4: repo atrasado — o diagnóstico certo vem ANTES do guard ----

test('repo atrasado: o conselho é "git pull --rebase", não "sua base local encolheu"', async (t) => {
  capturaLogs(t);
  // O cenário multi-máquina que originou o incidente: origin/main 1 commit à frente com 13758, o
  // site servindo 13758 e a base local CORRETA (2866), só desatualizada. Com o export rodando
  // primeiro, o usuário levava o bloqueio do guard — que culpa a base local.
  const git = fakeGit({ headArticles: 2866, behind: 1 });
  const d = deps({ git, novo: 2866, live: NO_AR_13758 });
  d.exportWeb = () => { throw new Error('o export NÃO pode rodar com o repo atrasado'); };
  await assert.rejects(
    runDeploy({}, d),
    (e) => {
      assert.ok(e instanceof DeployError);
      assert.match(e.message, /origin\/main está 1 commit\(s\) à frente/);
      assert.match(e.hint, /git pull --rebase/);
      // E não pode sugerir que a base local está errada: ela está certa.
      assert.equal(/MENOS artigos que o já publicado/.test(e.message), false);
      return true;
    },
  );
  // Aborta antes de escrever: nem export, nem restore, nem commit.
  assert.equal(git.fez('commit'), false);
  assert.equal(git.fez('push'), false);
  assert.equal(git.calls.includes(RESTORE_CALL), false, 'não há o que restaurar: nada foi exportado');
});

// ---- Y5: o opt-in, atravessando o parseFlags REAL ----

test('--allow-shrink wipe (com ESPAÇO) vira "wipe" no parser e libera o deploy, gritando', async (t) => {
  const linhas = capturaLogs(t);
  const { flags, rest } = parseFlags(['deploy', '--allow-shrink', 'wipe', '--no-wait']);
  assert.deepEqual(rest, ['deploy']);
  assert.equal(flags['allow-shrink'], 'wipe'); // e não a flag literal "allow-shrink=wipe"

  const git = fakeGit({ headArticles: 2866, dataStatus: ' M webapp/public/data/articles.json' });
  const res = await runDeploy(flags, deps({ git, novo: 0, live: NO_AR_2866 }));
  assert.equal(res.status, 'pushed');
  assert.ok(git.fez('push'));
  // O único caminho que apaga acervo publicado de propósito TEM de gritar.
  const gritos = linhas.filter((l) => l.startsWith('warn:') && l.includes('ATENÇÃO'));
  assert.ok(gritos.some((l) => l.includes('APAGADO')), `esperava o aviso de wipe, veio: ${gritos.join(' | ')}`);
  assert.ok(gritos.some((l) => l.includes('base de registro do acervo')));
});

test('--allow-shrink sozinho NÃO libera zerar (só o opt-in forte libera)', async (t) => {
  capturaLogs(t);
  const { flags } = parseFlags(['deploy', '--allow-shrink']);
  assert.equal(flags['allow-shrink'], true);
  const git = fakeGit({ headArticles: 2866, dataStatus: ' M webapp/public/data/articles.json' });
  await assert.rejects(
    runDeploy(flags, deps({ git, novo: 0, live: NO_AR_2866 })),
    (e) => e instanceof DeployError && /não libera zerar/.test(e.hint),
  );
  assert.equal(git.fez('push'), false);
});

test('--allow-shrink libera o encolhimento parcial (2866 → 1200) com aviso alto', async (t) => {
  const linhas = capturaLogs(t);
  const { flags } = parseFlags(['deploy', '--allow-shrink', '--no-wait']);
  const git = fakeGit({ headArticles: 2866, dataStatus: ' M webapp/public/data/articles.json' });
  const res = await runDeploy(flags, deps({ git, novo: 1200, live: NO_AR_2866 }));
  assert.equal(res.status, 'pushed');
  assert.ok(linhas.some((l) => l.startsWith('warn:') && l.includes('ENCOLHER em 1666')));
});

// ---- CONTRATO com a branch irmã `onda2-export-guard` (o guard também vive DENTRO do export) ----
//
// Estes dois testes exercitam um contrato, não uma proteção já vigente: a `exportWebSnapshot` desta
// árvore ignora `allowShrink`/`live` e nunca lança `SnapshotShrinkError` — é a irmã que implementa
// isso. Quem garante o bloqueio HOJE é o segundo cerco do deploy (guardSnapshot), coberto pelos
// testes Y1/Y2 acima. Para não ficarem tautológicos, eles LEEM o export real e cobram coerência:
// se ele ganhar o guard, tem de ser com o campo e o erro que o deploy trata.
const EXPORT_SRC = readFileSync(new URL('../src/export-web.js', import.meta.url), 'utf8');
const EXPORT_TEM_GUARD = /allowShrink/.test(EXPORT_SRC);

test('CONTRATO(irmã): o deploy repassa `allowShrink` e `live` ao exportWebSnapshot', async (t) => {
  capturaLogs(t);
  const git = fakeGit({ headArticles: 2866, dataStatus: ' M webapp/public/data/articles.json' });
  const d = deps({ git, novo: 2900, live: NO_AR_2866 });
  await runDeploy({ 'no-wait': true, 'allow-shrink': 'wipe' }, d);
  assert.equal(d.vistos.exportWeb.length, 1);
  const opts = d.vistos.exportWeb[0];
  assert.equal(opts.allowShrink, 'wipe');
  assert.deepEqual(opts.live, NO_AR_2866);
  assert.ok(String(opts.outDir).endsWith('webapp/public/data'));
  t.diagnostic(
    EXPORT_TEM_GUARD
      ? 'src/export-web.js JÁ honra allowShrink/live (irmã onda2-export-guard integrada)'
      : 'src/export-web.js IGNORA allowShrink/live nesta árvore — o bloqueio vem do guard do deploy',
  );
  // Falha ÚTIL: se o export passou a olhar o opt-in, o nome do campo tem de ser o que o deploy manda.
  if (EXPORT_TEM_GUARD) {
    assert.match(EXPORT_SRC, /\ballowShrink\b/, 'o export lê o opt-in com outro nome que não `allowShrink`');
    assert.match(EXPORT_SRC, /\blive\b/, 'o export ganhou guard mas não recebe o total NO AR — a base ficaria só o HEAD');
  }
});

test('CONTRATO(irmã): bloqueio TIPADO vindo do export vira DeployError e restaura a árvore', async (t) => {
  capturaLogs(t);
  // Falha ÚTIL: o dia em que o export recusar de verdade, o erro tem de ser TIPADO (`.verdict` ou
  // `SnapshotShrinkError`) — senão o deploy o trata como erro cru e o usuário perde a mensagem.
  if (EXPORT_TEM_GUARD) {
    assert.match(
      EXPORT_SRC, /SnapshotShrinkError|verdict/,
      'export com guard tem de sinalizar o bloqueio de forma TIPADA (name SnapshotShrinkError ou .verdict)',
    );
  }
  const git = fakeGit({ headArticles: 2866 });
  const erro = Object.assign(new Error('publicar este snapshot APAGARIA o acervo do site'), {
    name: 'SnapshotShrinkError',
    hint: 'restaure o banco e re-exporte',
    verdict: { action: 'block', reason: 'wipe' },
  });
  await assert.rejects(
    runDeploy({}, deps({ git, exportWeb: () => { throw erro; }, live: NO_AR_2866 })),
    (e) => e instanceof DeployError && e.message === erro.message && e.hint === erro.hint,
  );
  // O export pode ter escrito parte dos arquivos antes de recusar.
  assert.ok(git.calls.includes(RESTORE_CALL));
  assert.equal(git.fez('commit'), false);
});

test('erro NÃO tipado do export sobe cru (não vira "encolhimento")', async (t) => {
  capturaLogs(t);
  const git = fakeGit({ headArticles: 2866 });
  await assert.rejects(
    runDeploy({}, deps({ git, exportWeb: () => { throw new Error('disco cheio'); }, live: NO_AR_2866 })),
    (e) => !(e instanceof DeployError) && /disco cheio/.test(e.message),
  );
});

test('total do snapshot novo ILEGÍVEL bloqueia o deploy (fail-safe, não fail-open)', async (t) => {
  capturaLogs(t);
  const git = fakeGit({ headArticles: 2866 });
  await assert.rejects(
    // Um export que não devolve o total é exatamente o caso em que não dá p/ provar nada.
    runDeploy({}, deps({ git, exportWeb: () => ({ bytes: 1 }), live: NO_AR_2866 })),
    (e) => e instanceof DeployError && /NÃO consegue provar/.test(e.message),
  );
  assert.equal(git.fez('push'), false);
});

test('primeiro snapshot (nada publicado ainda) não é bloqueado', async (t) => {
  capturaLogs(t);
  const git = fakeGit({ headArticles: null, dataStatus: '?? webapp/public/data/articles.json' });
  const res = await runDeploy({ 'no-wait': true }, deps({ git, novo: 42, live: null }));
  assert.equal(res.status, 'pushed');
});

// ---- guardSnapshot isolado: as duas etapas ----

test('guardSnapshot: etapa export bloqueia, restaura e não inventa prefixo', (t) => {
  capturaLogs(t);
  let restaurou = 0;
  assert.throws(
    () => guardSnapshot({ novo: 0, head: 2866, live: 2866, restore: () => { restaurou++; } }),
    (e) => e instanceof DeployError && e.message.startsWith('publicar este snapshot APAGARIA'),
  );
  assert.equal(restaurou, 1, 'a árvore tem de ser restaurada ANTES de abortar');
});

test('guardSnapshot: com o HEAD abaixo do ar, o bloqueio manda consertar o COMMIT também', (t) => {
  capturaLogs(t);
  assert.throws(
    () => guardSnapshot({ novo: 0, head: 0, live: 13758 }),
    (e) => {
      assert.match(e.message, /^publicar este snapshot APAGARIA/);
      assert.match(e.hint, /RESTAURE o banco/);         // o hint do guard puro continua junto
      assert.match(e.hint, /JÁ ESTÁ COMMITADO no HEAD/); // + o diagnóstico do commit pendente
      assert.match(e.hint, /git revert/);
      return true;
    },
  );
  // A condição é HEAD < ar: com o HEAD em dia, nada de mandar reverter commit correto.
  assert.throws(
    () => guardSnapshot({ novo: 0, head: 13758, live: 13758 }),
    (e) => e instanceof DeployError && !/JÁ ESTÁ COMMITADO/.test(e.hint),
  );
});

test('guardSnapshot: veredito allow volta pro chamador; override grita, normal não', (t) => {
  const linhas = capturaLogs(t);
  const cresceu = guardSnapshot({ novo: 3000, head: 2866, live: 2866 });
  assert.equal(cresceu.action, 'allow');
  assert.equal(cresceu.reason, 'grow');
  assert.equal(linhas.length, 0, 'crescer não gera aviso');

  const override = guardSnapshot({ novo: 1200, head: 2866, live: 2866, allowShrink: true });
  assert.equal(override.override, true);
  assert.equal(linhas.filter((l) => l.startsWith('warn:')).length, 2);
});

// ---- Y3: restoreSnapshot cobre TODOS os arquivos do snapshot (num repo git de verdade) ----

const SNAPSHOT_FILES = [
  'webapp/public/data/meta.json',
  'webapp/public/data/articles.json',
  'webapp/public/data/contents.part0.json',
  'webapp/public/api/v1/corpus.json',
];

// Repo git descartável com um snapshot "cheio" commitado.
function repoComSnapshot(prefixo) {
  const repo = mkdtempSync(path.join(tmpdir(), prefixo));
  const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'teste@exemplo.invalido');
  g('config', 'user.name', 'Teste');
  g('config', 'commit.gpgsign', 'false');
  for (const rel of SNAPSHOT_FILES) {
    mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), `{"cheio": true, "arquivo": "${rel}"}\n`);
  }
  g('add', '-A');
  g('commit', '--no-verify', '-q', '-m', 'snapshot cheio');
  return { repo, g };
}

// O executor de git que o deploy usa, apontado p/ o repo do teste (mesma assinatura de src/deploy.js).
function gitEm(repo) {
  return (args, { allowFail = false } = {}) => {
    try {
      return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).replace(/\s+$/, '');
    } catch (e) {
      if (allowFail) return null;
      throw e;
    }
  };
}

// Simula o export num repo sem banco: todo arquivo do snapshot vira vazio e nasce uma parte nova.
function exportaVazio(repo) {
  for (const rel of SNAPSHOT_FILES) writeFileSync(path.join(repo, rel), '{"vazio": true}\n');
  writeFileSync(path.join(repo, 'webapp/public/data/contents.part9.json'), '{}\n');
}

test('restoreSnapshot devolve os QUATRO arquivos e deixa a árvore limpa', () => {
  const { repo, g } = repoComSnapshot('nc-deploy-restore-');
  exportaVazio(repo);
  assert.notEqual(g('status', '--porcelain').trim(), '', 'pré-condição: a árvore está suja');

  restoreSnapshot(gitEm(repo));

  for (const rel of SNAPSHOT_FILES) {
    const txt = readFileSync(path.join(repo, rel), 'utf8');
    assert.match(txt, /"cheio": true/, `${rel} não foi restaurado`);
  }
  // A parte NOVA que o export criou também some (restore/checkout não mexem em não-rastreado).
  assert.equal(existsSync(path.join(repo, 'webapp/public/data/contents.part9.json')), false);
  assert.equal(g('status', '--porcelain'), '', 'a árvore tem de ficar IDÊNTICA ao HEAD');
});

// Arquivos DO USUÁRIO guardados no dir de dados (não são do export — e um `backup-manual/` ali é
// exatamente o que alguém guarda na pasta do acervo).
const USER_FILES = [
  'webapp/public/data/ANOTACOES.md',
  'webapp/public/data/backup-manual/articles-2026-08-24.json',
  'webapp/public/api/v1/rascunho.txt',
];
function comArquivosDoUsuario(repo) {
  for (const rel of USER_FILES) {
    mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), 'trabalho do usuário — insubstituível\n');
  }
}
const sobreviveram = (repo) => USER_FILES.every((rel) => existsSync(path.join(repo, rel)));

test('restoreSnapshot remove SÓ o órfão do export — arquivo e pasta do usuário sobrevivem', (t) => {
  const linhas = capturaLogs(t);
  const { repo, g } = repoComSnapshot('nc-deploy-restore-usuario-');
  comArquivosDoUsuario(repo);
  exportaVazio(repo); // esvazia os 4 arquivos do snapshot e cria a parte NOVA (contents.part9.json)

  const removidos = restoreSnapshot(gitEm(repo));

  // O órfão do export sai...
  assert.deepEqual(removidos, ['webapp/public/data/contents.part9.json']);
  assert.equal(existsSync(path.join(repo, 'webapp/public/data/contents.part9.json')), false);
  // ...e o que não é do export FICA. Era aqui que o `git clean -fdq -- <dirs>` varria tudo.
  assert.ok(sobreviveram(repo), 'arquivo do usuário no dir de dados NÃO pode ser apagado pelo deploy');
  assert.ok(existsSync(path.join(repo, 'webapp/public/data/backup-manual')), 'nem o diretório dele');
  // O snapshot volta ao HEAD (o resto do trabalho do restore continua igual).
  assert.match(readFileSync(path.join(repo, 'webapp/public/data/articles.json'), 'utf8'), /"cheio": true/);
  // E remoção silenciosa não existe: o `-q` do clean antigo escondia o que sumia.
  assert.ok(linhas.some((l) => l.includes('contents.part9.json') && l.includes('removido')));
  // A árvore fica "suja" só com os arquivos do usuário — nada do snapshot.
  const sujo = g('status', '--porcelain').split('\n').filter(Boolean);
  assert.ok(sujo.every((l) => l.startsWith('??')), `sobrou mudança de snapshot: ${sujo.join(' | ')}`);
});

test(`a varredura de diretório (\`git ${CLEAN_VARRIDA}\`) não pode voltar a existir`, () => {
  const fonte = readFileSync(new URL('../src/deploy.js', import.meta.url), 'utf8');
  // A checagem é sobre o ARGV do git (o comentário pode citar o comando antigo à vontade).
  assert.equal(
    /'clean',\s*'-[a-z]*d[a-z]*'/.test(fonte), false,
    'clean com -d apaga o diretório do usuário inteiro (um backup-manual/ guardado no dir de dados)',
  );
  assert.equal(
    /'clean',[^)]*SNAPSHOT_REL/.test(fonte), false,
    'clean recebendo os DIRETÓRIOS varre tudo que não é rastreado — inclusive o que não é do export',
  );
});

test('o defeito é real: restaurar só meta+corpus deixava articles/contents esvaziados', () => {
  // Esta é a política ANTIGA (`restoreVolatile`), reproduzida aqui para provar o buraco: os
  // arquivos que sobram estão prontos p/ o próximo `git add` levar o snapshot vazio ao commit.
  const { repo, g } = repoComSnapshot('nc-deploy-restore-velho-');
  exportaVazio(repo);
  gitEm(repo)(['restore', '--', 'webapp/public/data/meta.json', 'webapp/public/api/v1/corpus.json']);

  assert.match(readFileSync(path.join(repo, 'webapp/public/data/meta.json'), 'utf8'), /"cheio"/);
  assert.match(readFileSync(path.join(repo, 'webapp/public/data/articles.json'), 'utf8'), /"vazio"/);
  assert.match(readFileSync(path.join(repo, 'webapp/public/data/contents.part0.json'), 'utf8'), /"vazio"/);
  assert.notEqual(g('status', '--porcelain'), '', 'a árvore continuava suja — o dado ia embora depois');
});

// ---- Y6: o repro do revisor virado teste — git REAL, do preflight ao bloqueio ----

const META_E2E = (n, stamp) => JSON.stringify({ schemaVersion: 1, generatedAt: stamp, totals: { articles: n } }, null, 1) + '\n';

/** Repo com `origin` de verdade (bare local: fetch funciona offline) e um snapshot de N artigos. */
function repoE2E(n, stamp) {
  const raiz = mkdtempSync(path.join(tmpdir(), 'nc-deploy-e2e-'));
  const repo = path.join(raiz, 'repo');
  const origin = path.join(raiz, 'origin.git');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).replace(/\s+$/, '');
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'teste@exemplo.invalido');
  g('config', 'user.name', 'Teste');
  g('config', 'commit.gpgsign', 'false');
  escreveSnapshotE2E(repo, n, stamp);
  g('add', '-A');
  g('commit', '--no-verify', '-q', '-m', `snapshot com ${n} artigos`);
  g('remote', 'add', 'origin', origin);
  g('push', '-q', 'origin', 'HEAD:refs/heads/main');
  return { repo, g };
}

// Escreve na árvore o que o export escreveria (meta/corpus com o total, articles/parte com corpo).
function escreveSnapshotE2E(repo, n, stamp) {
  for (const rel of SNAPSHOT_FILES) {
    mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    const conteudo = rel.endsWith('meta.json') || rel.endsWith('corpus.json')
      ? META_E2E(n, stamp)
      : `{"artigos": ${n}, "arquivo": "${rel}"}\n`;
    writeFileSync(path.join(repo, rel), conteudo);
  }
}

test('E2E com git real: o bloqueio do incidente não leva junto os arquivos do usuário', async (t) => {
  capturaLogs(t);
  const { repo, g } = repoE2E(2866, 'HEAD-STAMP');
  comArquivosDoUsuario(repo);

  await assert.rejects(
    runDeploy({}, {
      git: gitEm(repo),
      // O export com o banco vazio: reescreve a árvore com 0 artigos (é o 7c24491).
      exportWeb: () => { escreveSnapshotE2E(repo, 0, new Date().toISOString()); return { articles: 0, bytes: 1 }; },
      exportApi: () => ({ bytes: 1 }),
      fetchLive: async () => ({ generatedAt: 'G-NO-AR', articles: 2866 }),
    }),
    (e) => e instanceof DeployError && /APAGARIA o acervo do site/.test(e.message),
  );

  assert.ok(sobreviveram(repo), 'ANOTACOES.md/backup-manual/rascunho.txt do usuário TÊM de sobreviver');
  assert.equal(Number(g('rev-list', '--count', 'HEAD')), 1, 'nenhum commit podia nascer');
  // E o snapshot esvaziado não fica esperando o próximo `git add`.
  assert.match(readFileSync(path.join(repo, 'webapp/public/data/meta.json'), 'utf8'), /"articles": 2866/);
  const sujo = g('status', '--porcelain').split('\n').filter(Boolean);
  assert.ok(sujo.every((l) => l.startsWith('??')), `só o que é do usuário pode sobrar: ${sujo.join(' | ')}`);
});

test('E2E com git real: `--dry-run` e "nada a publicar" também deixam o usuário em paz', async (t) => {
  capturaLogs(t);
  // Estes dois ramos só são ALCANÇÁVEIS sem nada não-rastreado no dir de dados (um arquivo solto
  // ali entra no `status --porcelain` e vira "dado novo", levando o deploy a publicar). O jeito de
  // guardar rascunho numa pasta versionada é o .gitignore — é esse o cenário aqui; o caso do
  // arquivo NÃO-rastreado está no teste do bloqueio acima e no de `restoreSnapshot`.
  const casos = [
    // Site servindo exatamente o snapshot do HEAD e nada pendente => "nada a publicar".
    { esperado: 'up-to-date', flags: { 'no-wait': true }, liveStamp: 'HEAD-STAMP' },
    // Site atrasado (republicaria), mas em --dry-run: o bump do generatedAt tem de ser desfeito.
    { esperado: 'dry-run', flags: { 'dry-run': true }, liveStamp: 'G-DE-UM-BUILD-VELHO' },
  ];
  for (const { esperado, flags, liveStamp } of casos) {
    const { repo, g } = repoE2E(2866, 'HEAD-STAMP');
    writeFileSync(path.join(repo, 'webapp/public/data/.gitignore'), 'ANOTACOES.md\nbackup-manual/\n');
    writeFileSync(path.join(repo, 'webapp/public/api/v1/.gitignore'), 'rascunho.txt\n');
    g('add', '-A');
    g('commit', '--no-verify', '-q', '-m', 'usuário versiona o .gitignore dos rascunhos dele');
    g('push', '-q', 'origin', 'HEAD:refs/heads/main'); // ahead=0: senão o motivo vira `unpushed`
    comArquivosDoUsuario(repo);
    const commitsAntes = Number(g('rev-list', '--count', 'HEAD'));

    const r = await runDeploy(flags, {
      git: gitEm(repo),
      // Export sem dado novo: só o carimbo de hora muda.
      exportWeb: () => { escreveSnapshotE2E(repo, 2866, new Date().toISOString()); return { articles: 2866, bytes: 1 }; },
      exportApi: () => ({ bytes: 1 }),
      fetchLive: async () => ({ generatedAt: liveStamp, articles: 2866 }),
    });

    assert.equal(r.status, esperado, `ramo errado: ${r.status}`);
    assert.ok(sobreviveram(repo), `arquivos do usuário sumiram no ramo ${r.status}`);
    assert.ok(existsSync(path.join(repo, 'webapp/public/data/backup-manual')));
    assert.equal(Number(g('rev-list', '--count', 'HEAD')), commitsAntes, 'nada a publicar, nada a commitar');
    assert.equal(g('status', '--porcelain'), '', 'e o bump do generatedAt é desfeito');
  }
});
