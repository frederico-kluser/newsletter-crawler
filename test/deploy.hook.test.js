// O hook `.githooks/pre-push` RODANDO DE VERDADE, num repositório git descartável. Não é um teste
// da regra (isso é test/snapshot-guard.test.js): é a prova de que o hook CHAMA a regra — o arquivo
// real, com bash real, git real e o `node -e` que importa `src/snapshot-guard.js`.
//
// O que o hook antigo errava e está fixado aqui:
//   (a) `if [ -n "$total_novo" ] && [ -n "$total_head" ]` — falha de LEITURA desligava o guard;
//   (b) comparava só com `HEAD:meta.json` — um ratchet: entrado um snapshot encolhido no HEAD,
//       tudo >= a ele passava para sempre. Agora o total NO AR entra na conta.
//
// O repositório de teste ganha um `src/index.js` de mentira (o "export") e um SYMLINK para o
// snapshot-guard REAL: é assim que o hook roda inteiro sem banco, sem rede e sem tocar no repo
// deste projeto.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(REPO, '.githooks', 'pre-push');
const GUARD = path.join(REPO, 'src', 'snapshot-guard.js');
const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-hook-test-home-'));

// "Export" de mentira: escreve os MESMOS quatro arquivos que o export real, com o total pedido por
// env. NC_FAKE_META_BAD=1 escreve um meta.json sem `totals.articles` — o caso "total ilegível".
const STUB_EXPORT = `import { mkdirSync, writeFileSync } from 'node:fs';
const n = Number(process.env.NC_FAKE_ARTICLES || 0);
const generatedAt = new Date().toISOString();
const totals = process.env.NC_FAKE_META_BAD === '1' ? {} : { articles: n };
const gravar = (rel, data) => writeFileSync(rel, JSON.stringify(data, null, 1) + '\\n');
mkdirSync('webapp/public/data', { recursive: true });
mkdirSync('webapp/public/api/v1', { recursive: true });
const artigos = Array.from({ length: n }, (_, i) => ({ id: i, title: 'artigo ' + i }));
gravar('webapp/public/data/meta.json', { schemaVersion: 1, generatedAt, totals });
gravar('webapp/public/data/articles.json', artigos);
gravar('webapp/public/data/contents.part0.json', Object.fromEntries(artigos.map((a) => [a.id, 'corpo'])));
if (process.env.NC_FAKE_EXTRA_PART === '1') gravar('webapp/public/data/contents.part1.json', { extra: true });
gravar('webapp/public/api/v1/corpus.json', { schemaVersion: 1, generatedAt, totals, items: artigos });
console.log('export web (stub): ' + n + ' artigos');
`;

/** Repo git descartável, com o hook + o guard REAIS e um snapshot de `headArticles` no HEAD. */
function repoDeTeste(headArticles) {
  const repo = mkdtempSync(path.join(tmpdir(), 'nc-hook-test-repo-'));
  const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).replace(/\s+$/, '');
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'teste@exemplo.invalido');
  g('config', 'user.name', 'Teste');
  g('config', 'commit.gpgsign', 'false');

  writeFileSync(path.join(repo, 'package.json'), '{ "name": "fixture", "type": "module" }\n');
  mkdirSync(path.join(repo, 'src'));
  writeFileSync(path.join(repo, 'src', 'index.js'), STUB_EXPORT);
  symlinkSync(GUARD, path.join(repo, 'src', 'snapshot-guard.js'));
  mkdirSync(path.join(repo, '.githooks'));
  symlinkSync(HOOK, path.join(repo, '.githooks', 'pre-push'));

  // O snapshot do HEAD nasce do MESMO "export": formato idêntico ao que o hook vai gerar.
  rodarStub(repo, headArticles);
  g('add', '-A');
  g('commit', '--no-verify', '-q', '-m', `snapshot com ${headArticles} artigos`);
  return { repo, g, sha: g('rev-parse', 'HEAD') };
}

function rodarStub(repo, artigos, { metaRuim = false } = {}) {
  execFileSync('node', ['src/index.js', 'export', '--format', 'web'], {
    cwd: repo,
    stdio: 'pipe',
    env: { ...process.env, NC_FAKE_ARTICLES: String(artigos), NC_FAKE_META_BAD: metaRuim ? '1' : '0', NC_FAKE_EXTRA_PART: '0' },
  });
}

/**
 * Dispara o hook exatamente como o git faria (argv + stdin do pre-push).
 * ASSÍNCRONO de propósito: o guard consulta o "site no ar", que nos testes é um servidor HTTP
 * DESTE processo — um `spawnSync` travaria o event loop e o servidor nunca responderia (a consulta
 * caía no timeout e o teste passava por engano).
 */
function rodarHook(repo, sha, { artigos, metaRuim = false, allowShrink = null, siteUrl = null, remoteRef = 'refs/heads/main', parteExtra = false, liveMs = null } = {}) {
  const env = {
    ...process.env,
    NC_HOME: NC_HOME_TMP,
    NC_FAKE_ARTICLES: String(artigos),
    NC_FAKE_META_BAD: metaRuim ? '1' : '0',
    NC_FAKE_EXTRA_PART: parteExtra ? '1' : '0',
    // Sem site configurado, o guard não consulta a rede (o total do ar fica desconhecido).
    NC_HOOK_LIVE_MS: liveMs != null ? String(liveMs) : (siteUrl ? '4000' : '0'),
  };
  if (siteUrl) env.NC_SITE_URL = siteUrl;
  if (allowShrink) env.NC_ALLOW_SHRINK = allowShrink;
  else delete env.NC_ALLOW_SHRINK;
  const zero = '0'.repeat(40);
  return new Promise((resolve) => {
    const p = spawn('bash', ['.githooks/pre-push', 'origin', 'https://exemplo.invalido/r.git'], { cwd: repo, env });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
    p.stdin.end(`refs/heads/main ${sha} ${remoteRef} ${zero}\n`);
  });
}

const saida = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const commits = (g) => Number(g('rev-list', '--count', 'HEAD'));

// Servidor local no lugar do site em produção (o guard só precisa de um meta.json).
async function siteNoAr(artigos) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ schemaVersion: 1, generatedAt: '2026-09-01T00:00:00.000Z', totals: { articles: artigos } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, fechar: () => new Promise((r) => server.close(r)) };
}

const servidores = [];
after(async () => { for (const s of servidores) await s.fechar(); });

// ---- o guard não deixa o encolhimento ser COMMITADO ----

test('hook: export de 0 artigos sobre 2866 no HEAD não commita e restaura a árvore', async () => {
  const { repo, g, sha } = repoDeTeste(2866);
  const r = await rodarHook(repo, sha, { artigos: 0 });

  assert.match(saida(r), /APAGARIA o acervo do site/);
  assert.equal(commits(g), 1, 'nenhum commit novo podia nascer');
  assert.equal(g('status', '--porcelain'), '', 'a árvore tem de voltar ao HEAD');
  // Push segue: o hook nunca trava trabalho legítimo por causa do snapshot novo.
  assert.equal(r.status, 0);
});

test('hook: total ILEGÍVEL bloqueia (o guard antigo se desligava sozinho)', async () => {
  const { repo, g, sha } = repoDeTeste(2866);
  const r = await rodarHook(repo, sha, { artigos: 0, metaRuim: true });

  assert.match(saida(r), /NÃO consegue provar/);
  assert.equal(commits(g), 1, 'sem o total não dá p/ provar nada: não commita');
  assert.equal(g('status', '--porcelain'), '');
  assert.equal(r.status, 0);
});

test('hook: a decisão NÃO está duplicada em bash — vem de src/snapshot-guard.js', async () => {
  const fonte = execFileSync('cat', [HOOK], { encoding: 'utf8' });
  assert.match(fonte, /from "\.\/src\/snapshot-guard\.js"/);
  assert.match(fonte, /evaluateSnapshotChange/);
  // A comparação numérica que ERA a regra ("-lt" entre os dois totais) não existe mais.
  assert.equal(/total_novo"?\s*-lt/.test(fonte), false, 'a regra voltou a ser reimplementada em bash');
});

// ---- o caminho normal continua igual ----

test('hook: dado novo é commitado e o push é interrompido de propósito', async () => {
  const { repo, g, sha } = repoDeTeste(2866);
  const r = await rodarHook(repo, sha, { artigos: 3000 });

  assert.equal(r.status, 1, 'commit criado durante o push não entra nele: o hook aborta');
  assert.match(saida(r), /INTERROMPIDO de propósito/);
  assert.equal(commits(g), 2);
  assert.match(g('show', '-s', '--format=%s', 'HEAD'), /3000 artigos/);
  assert.equal(g('status', '--porcelain'), '');
});

test('hook: sem dado novo (só o generatedAt), restaura e o push segue', async () => {
  const { repo, g, sha } = repoDeTeste(2866);
  const r = await rodarHook(repo, sha, { artigos: 2866 });

  assert.equal(r.status, 0);
  assert.match(saida(r), /já em dia/);
  assert.equal(commits(g), 1);
  assert.equal(g('status', '--porcelain'), '');
});

// ---- opt-in explícito ----

test('hook: NC_ALLOW_SHRINK=wipe libera zerar, gritando o override', async () => {
  const { repo, g, sha } = repoDeTeste(2866);
  const r = await rodarHook(repo, sha, { artigos: 0, allowShrink: 'wipe' });

  assert.match(saida(r), /ATENCAO override/);
  assert.equal(commits(g), 2, 'com o opt-in forte o snapshot vazio É commitado');
  assert.equal(r.status, 1); // commitou: repita o push (fluxo normal do hook)
});

test('hook: NC_ALLOW_SHRINK=1 NÃO libera zerar (só encolher)', async () => {
  const { repo, g, sha } = repoDeTeste(2866);
  const r = await rodarHook(repo, sha, { artigos: 0, allowShrink: '1' });

  assert.match(saida(r), /não libera zerar/);
  assert.equal(commits(g), 1);
});

// ---- o total NO AR entra na conta: fim do ratchet ----

test('hook: snapshot encolhido JÁ no HEAD não vira licença — o site no ar é a base', async () => {
  // O ratchet do guard antigo: HEAD já tem 100 (um snapshot encolhido que entrou antes), o export
  // traz 150 e `150 -lt 100` é falso => passava. Com o total no ar (13758) a base é outra.
  const site = await siteNoAr(13758);
  servidores.push(site);
  const { repo, g, sha } = repoDeTeste(100);
  const r = await rodarHook(repo, sha, { artigos: 150, siteUrl: site.url });

  assert.match(saida(r), /13758/);
  assert.equal(commits(g), 1, 'o snapshot encolhido não podia ser commitado');
  assert.equal(g('status', '--porcelain'), '', 'e a árvore volta ao HEAD');
  // E como o que JÁ ESTÁ commitado (100) destruiria os 13758 no ar, o push do ramo de publicação
  // é abortado: deixá-lo seguir seria publicar a destruição.
  assert.equal(r.status, 1);
  assert.match(saida(r), /PUSH ABORTADO/);
});

test('hook: o abort do push só vale p/ o ramo que publica', async () => {
  const site = await siteNoAr(13758);
  servidores.push(site);
  const { repo, g, sha } = repoDeTeste(100);
  const r = await rodarHook(repo, sha, { artigos: 150, siteUrl: site.url, remoteRef: 'refs/heads/feature-x' });

  assert.equal(r.status, 0, 'push de branch de trabalho não é travado');
  assert.equal(/PUSH ABORTADO/.test(saida(r)), false);
  assert.equal(commits(g), 1, 'mas o snapshot encolhido continua sem ser commitado');
  assert.equal(g('status', '--porcelain'), '');
});

test('hook: com o site em dia, tudo segue o fluxo normal', async () => {
  const site = await siteNoAr(2866);
  servidores.push(site);
  const { repo, g, sha } = repoDeTeste(2866);
  const r = await rodarHook(repo, sha, { artigos: 2900, siteUrl: site.url });

  assert.equal(r.status, 1);
  assert.match(saida(r), /INTERROMPIDO de propósito/);
  assert.equal(commits(g), 2);
});

// ---- deleção de ref não dispara nada ----

test('hook: deleção de ref não exporta nem toca no snapshot', async () => {
  const { repo, g } = repoDeTeste(2866);
  const zero = '0'.repeat(40);
  const r = spawnSync('bash', ['.githooks/pre-push', 'origin', 'https://exemplo.invalido/r.git'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, NC_HOME: NC_HOME_TMP, NC_HOOK_LIVE_MS: '0' },
    input: `(delete) ${zero} refs/heads/main ${zero}\n`,
  });
  assert.equal(r.status, 0);
  assert.equal(saida(r).trim(), '');
  assert.equal(commits(g), 1);
  assert.ok(existsSync(path.join(repo, 'webapp/public/data/meta.json')));
});

// ---- o restore do hook é do EXPORT, não do diretório ----

test('hook: o restore não apaga arquivo do usuário — só o órfão que o export criou', async () => {
  const { repo, g, sha } = repoDeTeste(2866);
  // Rascunhos do usuário na pasta do acervo. `backup-manual/` ali é plausível justamente porque é
  // a pasta dos dados — e um `git clean -fd` a levaria inteira, em silêncio.
  const anotacoes = path.join(repo, 'webapp/public/data/ANOTACOES.md');
  const backup = path.join(repo, 'webapp/public/data/backup-manual/articles-2026-08-24.json');
  writeFileSync(anotacoes, 'notas do usuário\n');
  mkdirSync(path.dirname(backup), { recursive: true });
  writeFileSync(backup, '{"acervo": "backup manual"}\n');

  // Export de 0 artigos (bloqueia) criando também uma PARTE NOVA, que é órfã: não existe no HEAD.
  const r = await rodarHook(repo, sha, { artigos: 0, parteExtra: true });

  assert.match(saida(r), /APAGARIA o acervo do site/);
  assert.equal(commits(g), 1, 'o encolhimento não podia ser commitado');
  assert.ok(existsSync(anotacoes), 'ANOTACOES.md do usuário foi apagado pelo hook');
  assert.ok(existsSync(backup), 'backup-manual/ do usuário foi apagado pelo hook');
  // O que É do export sai — e sai FALANDO (o `-q` do clean antigo escondia o sumiço).
  assert.equal(existsSync(path.join(repo, 'webapp/public/data/contents.part1.json')), false);
  assert.match(saida(r), /removendo arquivo novo do export: webapp\/public\/data\/contents\.part1\.json/);
  // O snapshot volta ao HEAD; o que sobra sujo é só o que é do usuário.
  const sujo = g('status', '--porcelain').split('\n').filter(Boolean);
  assert.ok(sujo.every((l) => l.startsWith('??')), `sobrou mudança de snapshot: ${sujo.join(' | ')}`);
});

test('hook: a varredura de diretório (git clean -fd) não pode voltar ao restore', () => {
  // Só o CÓDIGO: o comentário do hook cita o comando antigo de propósito, p/ dizer por que saiu.
  const codigo = readFileSync(HOOK, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.equal(/git clean -[a-z]*d/.test(codigo), false, 'clean com -d apaga o diretório do usuário inteiro');
  assert.equal(/git clean [^\n]*"\$DATA_DIR"/.test(codigo), false, 'clean recebendo os DIRETÓRIOS varre o que não é do export');
});

// ---- F4: o guard sai assim que decide (senão o push paga o socket pendurado) ----

test('hook: o guard grava o veredito INTEIRO e sai — nem com o site pendurado o push espera', async () => {
  // Servidor TCP que ACEITA e nunca responde: a consulta ao ar morre no NC_HOOK_LIVE_MS. O veredito
  // (stdout, capturado por PIPE pelo hook) tem de chegar completo mesmo com o process.exit() logo
  // depois — se truncasse, o bash cairia no fallback "? ? ? block allow" e NADA seria commitado.
  const mudo = createTcpServer(() => {});
  await new Promise((r) => mudo.listen(0, '127.0.0.1', r));
  const { repo, g, sha } = repoDeTeste(2866);
  const t0 = Date.now();
  const r = await rodarHook(repo, sha, {
    artigos: 3000, siteUrl: `http://127.0.0.1:${mudo.address().port}`, liveMs: 700,
  });
  const gasto = Date.now() - t0;
  mudo.close();

  // Commitou com o total que veio do veredito: prova que a linha chegou inteira e foi parseada.
  assert.equal(commits(g), 2);
  assert.match(g('show', '-s', '--format=%s', 'HEAD'), /3000 artigos/);
  assert.equal(r.status, 1, 'commitou durante o push: o hook aborta p/ o commit não ficar de fora');
  // E o hook não fica pendurado além do orçamento da consulta (no cenário de SYN dropado era o
  // connectTimeout de 10s do undici que segurava o processo, muito depois do abort).
  assert.ok(gasto < 8000, `o hook demorou ${gasto}ms — o guard voltou a esperar o socket`);
});

test('hook: o guard sai explicitamente depois de escrever o veredito', () => {
  const fonte = readFileSync(HOOK, 'utf8');
  // Escrita SÍNCRONA (writeSync) + process.exit: com `process.stdout.write` num pipe, o exit
  // truncaria a saída; sem o exit, o processo espera o socket de connect pendente (10s).
  assert.match(fonte, /writeSync\(/);
  assert.match(fonte, /process\.exit\(0\);/);
  const idxVeredito = fonte.indexOf('escreve(1, [n(novo)');
  const idxExit = fonte.indexOf('process.exit(0);');
  assert.ok(idxVeredito > 0 && idxExit > idxVeredito, 'o exit tem de vir DEPOIS de gravar o veredito');
});
