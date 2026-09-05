// RESTORE a partir do GIT (src/restore.js): a base de registro é o snapshot versionado, não o
// SQLite local. O que precisa valer, e que este arquivo prova sobre um REPO DE MENTIRA construído
// aqui (git init + commits fabricados, nada do repo real é lido):
//   - os DOIS formatos de conteúdo do histórico (contents.json legado E contents.partN.json);
//   - merge por RIQUEZA (o registro rico VENCE o recente — a política oposta perde resumos/tags);
//   - identidade por URL: ids do snapshot MAIS NOVO preservados, os demais alocados acima do
//     maior id (os ids do histórico colidem: cada wipe reiniciou o rowid em 1);
//   - idempotência (2ª passada não duplica) e escrita numa ÚNICA transação (rollback total);
//   - o MARCADOR DE WIPE faz o restore ignorar os commits anteriores (senão o `reset` nunca
//     funciona: `git rm` não apaga o histórico e o restore ressuscitaria o que foi apagado) — e
//     a fronteira RESISTE A UM REBASE de verdade (`git rebase --root`), no próprio repo e num
//     clone do repo reescrito, com marcador v1 (só commit+at) e v2 (com authorAt/snapshotAt);
//   - a POLÍTICA DE CORPO ('best'): o corpo mais NOVO não é o melhor — quem vence é o de maior
//     SUBSTÂNCIA, HTML cru perde para texto e um artigo com exemplo de código NÃO é HTML cru;
//   - a varredura dos contents NÃO materializa o arquivo inteiro (medido por instrumentação);
//   - o ORÇAMENTO DE MEMÓRIA degrada (metadados sem corpos / para no snapshot atual) em vez de
//     deixar o V8 abortar o processo com "Reached heap limit";
//   - maybeAutoRestore NUNCA dispara em base cheia nem sob a suíte de testes, e SEMPRE loga o
//     motivo do pulo.
// NC_HOME em tmpdir ANTES de importar db/restore (padrão do repo) — o banco real nunca é aberto.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Nome PRÓPRIO para o NC_HOME isolado deste arquivo: qualquer restauração de env volta para ELE,
// nunca para um valor possivelmente ausente (`process.env.NC_HOME = undefined` vira a string
// "undefined" e o src/config.js cairia no default ~/.newsletter-crawler — o banco REAL).
const NC_HOME_TMP = mkdtempSync(path.join(os.tmpdir(), 'nc-restore-'));
process.env.NC_HOME = NC_HOME_TMP;
const { db, stmts, wipeAll, countArticles, restoreArticle, restoreSourceByName } = await import('../src/db.js');
const { setLogSink } = await import('../src/util.js');
const {
  collectFromGit, restoreFromGit, maybeAutoRestore, isUnderTest, isShallowRepo,
  readWipeMarker, writeWipeMarker, scanContentsBuffer, metaRichness, WIPE_MARKER_FILE,
  looksLikeRawHtml, substanceLength,
} = await import('../src/restore.js');

const tmps = [NC_HOME_TMP];
after(() => {
  db.close();
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

function tmpdir(prefix) {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(d);
  return d;
}

// ---- repo de mentira com snapshots fabricados ----

function git(dir, args, when = null) {
  return String(
    execFileSync('git', args, {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
        GIT_TERMINAL_PROMPT: '0',
        // Datas FIXAS quando o teste precisa delas (a fronteira do wipe é uma comparação de
        // datas no fallback): sem isto, todo commit do fixture nasce no mesmo segundo.
        ...(when ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {}),
      },
    }),
  ).trim();
}

const DATA = 'webapp/public/data';

// Escreve um snapshot COM O MESMO layout do export (JSON.stringify(x, null, 1)) — é isso que faz
// a varredura linha-a-linha dos contents ser exercitada de verdade.
function writeSnapshot(root, { articles, contents = null, parts = null, generatedAt, sources = [], minified = false }) {
  const dir = path.join(root, DATA);
  mkdirSync(dir, { recursive: true });
  const meta = { schemaVersion: 1, generatedAt, totals: { articles: articles.length }, sources };
  if (parts) meta.contentsParts = parts.map((p) => ({ file: p.file, from: p.from, to: p.to }));
  const dump = (o) => (minified ? JSON.stringify(o) : `${JSON.stringify(o, null, 1)}\n`);
  writeFileSync(path.join(dir, 'meta.json'), dump(meta));
  writeFileSync(path.join(dir, 'articles.json'), dump(articles));
  rmSync(path.join(dir, 'contents.json'), { force: true });
  for (let i = 0; i < 8; i += 1) rmSync(path.join(dir, `contents.part${i}.json`), { force: true });
  if (parts) for (const p of parts) writeFileSync(path.join(dir, p.file), dump(p.map));
  else writeFileSync(path.join(dir, 'contents.json'), dump(contents || {}));
}

const SRC = [{ id: 1, name: 'Fonte Um', count: 9 }];

// Artigo do snapshot no shape EXATO do webExportArticles (id, source_id, url, …, snippet, tags).
function snapRow(id, url, extra = {}) {
  return {
    id, source_id: 1, url,
    title: `T ${url}`, title_pt: null, summary_pt: null,
    snippet: `snippet ${url}`, date_iso: '2026-03-01',
    kind: 'news', section: 'News', verify_status: null, verify_notes: null,
    tags: {}, ...extra,
  };
}

// Commit A (ANTIGO, formato LEGADO contents.json, metadados RICOS) e commit B (NOVO, formato em
// PARTES, metadados POBRES para /a e ids REINICIADOS — exatamente o que um wipe produz).
function buildFixtureRepo() {
  const root = tmpdir('nc-fix-repo-');
  git(root, ['init', '-b', 'main', '-q']);
  git(root, ['config', 'commit.gpgsign', 'false']);

  writeSnapshot(root, {
    generatedAt: '2026-01-01T00:00:00.000Z',
    sources: SRC,
    articles: [
      snapRow(1, 'https://ex.test/a', {
        title: 'A RICO', title_pt: 'A em PT', summary_pt: 'resumo rico de a',
        verify_status: 'ok', tags: { domain: ['web'], 'topic-technology': ['node'] },
      }),
      snapRow(2, 'https://ex.test/b', { summary_pt: 'resumo de b', tags: { domain: ['web'] } }),
      snapRow(3, 'https://ex.test/c'),
    ],
    contents: { 1: 'corpo antigo de a', 2: 'corpo de b', 3: 'corpo de c' },
  });
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--no-verify', '-m', 'snapshot antigo (contents.json legado)']);
  const commitA = git(root, ['rev-parse', 'HEAD']);

  writeSnapshot(root, {
    generatedAt: '2026-02-01T00:00:00.000Z',
    sources: SRC,
    articles: [
      // /a volta POBRE (sem resumo, sem tags) e com id 1 — o wipe reiniciou o rowid
      snapRow(1, 'https://ex.test/a', { title: 'A POBRE' }),
      // /d é novo e leva o id 2, que no snapshot ANTIGO era de /b (colisão real de id)
      snapRow(2, 'https://ex.test/d', { summary_pt: 'resumo de d', tags: { domain: ['ia'] } }),
    ],
    parts: [
      { file: 'contents.part0.json', from: 1, to: 1, map: { 1: 'corpo NOVO de a, mais longo' } },
      { file: 'contents.part1.json', from: 2, to: 2, map: { 2: 'corpo de d' } },
    ],
  });
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--no-verify', '-m', 'snapshot novo (contents em partes)']);
  const commitB = git(root, ['rev-parse', 'HEAD']);
  return { root, commitA, commitB };
}

const FIX = buildFixtureRepo();

// Repo dedicado à POLÍTICA DE CORPO. Aqui o corpo mais NOVO é o PIOR — que é o caso REAL medido
// no acervo (916 artigos com corpo maior num snapshot antigo, 1.224.751 caracteres; nos maiores,
// o corpo novo era só o título, a moldura do GitHub ou o blurb do agregador). No fixture antigo o
// corpo mais novo era TAMBÉM o mais longo, então as políticas eram indistinguíveis e o teste de
// 'longest' passava mesmo com a política desligada.
const LONG_BODY = `CHANGELOG 8.2.0\n${'linha de conteúdo de verdade do changelog. '.repeat(120)}`;
const RAW_HTML_BODY = `<div class="app"><nav><a href="/x">menu</a></nav>${'<p>parágrafo de moldura</p>'.repeat(40)}</div>`;
const CLEAN_BODY = `Texto limpo do artigo. ${'frase curta de conteúdo. '.repeat(10)}`;
// MESMO texto, só com linhas em branco a mais (extração antiga): é maior em BYTES e idêntico em
// SUBSTÂNCIA — o caso de 351 dos 916, em que "o maior" não trazia conteúdo nenhum a mais.
const SPACED_BODY = CLEAN_BODY.replace(/\. /g, '.\n\n\n');

function buildBodyFixtureRepo() {
  const root = tmpdir('nc-body-repo-');
  git(root, ['init', '-b', 'main', '-q']);
  git(root, ['config', 'commit.gpgsign', 'false']);

  // ANTIGO: corpos BONS (e um HTML cru, que é o lixo do lado antigo).
  writeSnapshot(root, {
    generatedAt: '2026-01-01T00:00:00.000Z',
    sources: SRC,
    articles: [
      snapRow(1, 'https://ex.test/vite'),
      snapRow(2, 'https://ex.test/html'),
      snapRow(3, 'https://ex.test/espaco'),
      snapRow(4, 'https://ex.test/empate', { title: 'T VELHO' }),
    ],
    contents: { 1: LONG_BODY, 2: RAW_HTML_BODY, 3: SPACED_BODY, 4: 'corpo do empate' },
  });
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--no-verify', '-m', 'snapshot antigo (corpos bons)']);

  // NOVO: corpos POBRES — o título sozinho, um texto limpo curto e o mesmo texto sem os brancos.
  writeSnapshot(root, {
    generatedAt: '2026-02-01T00:00:00.000Z',
    sources: SRC,
    articles: [
      snapRow(1, 'https://ex.test/vite'),
      snapRow(2, 'https://ex.test/html'),
      snapRow(3, 'https://ex.test/espaco'),
      snapRow(4, 'https://ex.test/empate', { title: 'T NOVO' }),
    ],
    parts: [
      {
        file: 'contents.part0.json',
        from: 1,
        to: 4,
        map: { 1: 'Vite 8.2', 2: CLEAN_BODY, 3: CLEAN_BODY, 4: 'corpo do empate' },
      },
    ],
  });
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--no-verify', '-m', 'snapshot novo (corpos pobres)']);
  return { root };
}

const BODYFIX = buildBodyFixtureRepo();

// ---- varredura dos contents (o leitor dos DOIS formatos) ----

test('scanContentsBuffer: lê o mapa linha a linha (layout do export) sem parsear o arquivo todo', () => {
  const buf = Buffer.from(`${JSON.stringify({ 7: 'sete', 8: 'oi\n"aspas"' }, null, 1)}\n`);
  const seen = new Map();
  const n = scanContentsBuffer(buf, (id, body) => seen.set(id, body));
  assert.equal(n, 2);
  assert.equal(seen.get(7), 'sete');
  assert.equal(seen.get(8), 'oi\n"aspas"', 'quebra de linha e aspas escapadas sobrevivem');
});

test('scanContentsBuffer: NÃO materializa o arquivo inteiro (a decisão de memória do módulo)', (t) => {
  // O nome do teste acima é a afirmação — e ela é MEDIDA aqui, não só declarada. 24 MB no layout
  // do export: se a varredura linha-a-linha estivesse desligada, o fallback parsearia o arquivo
  // TODO (um JSON.parse de 24 MB e um objeto de 24 MB vivo durante os callbacks).
  const map = {};
  const body = 'x'.repeat(8000);
  for (let i = 1; i <= 3000; i += 1) map[i] = `${body}${i}`;
  const buf = Buffer.from(`${JSON.stringify(map, null, 1)}\n`);
  assert.ok(buf.length > 20 * 1048576, `buffer de ${buf.length} bytes`);

  // Duas instrumentações DETERMINÍSTICAS (medir heap seria refém do GC): o maior pedaço que
  // virou string e o maior pedaço que foi parseado. No fallback os dois seriam o arquivo INTEIRO.
  const realParse = JSON.parse;
  const realToString = Buffer.prototype.toString;
  let maxParseInput = 0;
  let maxMaterialized = 0;
  let peakHeap = 0;
  const base = process.memoryUsage().heapUsed;
  JSON.parse = (txt, ...rest) => {
    if (typeof txt === 'string' && txt.length > maxParseInput) maxParseInput = txt.length;
    return realParse(txt, ...rest);
  };
  Buffer.prototype.toString = function instrumented(enc, from, to) {
    const bytes = (to === undefined ? this.length : to) - (from === undefined ? 0 : from);
    if (bytes > maxMaterialized) maxMaterialized = bytes;
    return realToString.call(this, enc, from, to);
  };
  let n = 0;
  try {
    n = scanContentsBuffer(buf, () => {
      const used = process.memoryUsage().heapUsed - base;
      if (used > peakHeap) peakHeap = used;
    });
  } finally {
    Buffer.prototype.toString = realToString;
    JSON.parse = realParse;
  }
  assert.equal(n, 3000);
  assert.ok(maxParseInput < 16384, `nenhum JSON.parse recebeu mais que UMA linha (maior: ${maxParseInput})`);
  assert.ok(maxMaterialized < 65536, `nenhum trecho do buffer virou string além de uma linha (maior: ${maxMaterialized})`);
  t.diagnostic(`arquivo ${buf.length} B; maior string ${maxMaterialized} B; maior JSON.parse ${maxParseInput} B; heap ~${peakHeap} B`);
});

test('scanContentsBuffer: shouldRead corta o corpo ANTES de materializar (e não vira fallback)', () => {
  // O corte por tamanho de linha é o que deixa 'best'/'longest' varrerem os ~889 MB do histórico.
  const buf = Buffer.from(`${JSON.stringify({ 1: 'curto', 2: 'x'.repeat(500) }, null, 1)}\n`);
  const seen = [];
  const n = scanContentsBuffer(buf, (id, b) => seen.push([id, b.length]), {
    shouldRead: (id, maxLen) => maxLen > 100,
  });
  assert.equal(n, 1, 'só o corpo grande foi materializado');
  assert.deepEqual(seen, [[2, 500]]);
  // filtrar TUDO não pode disparar o fallback de "formato desconhecido" (que leria o arquivo todo)
  assert.equal(scanContentsBuffer(buf, () => assert.fail('nada deveria ser lido'), { shouldRead: () => false }), 0);
});

test('scanContentsBuffer: erro vindo do onEntry SOBE (o try cobre só o parse)', () => {
  // O vigia de memória para a fase LANÇANDO de dentro do callback; se o try/catch da linha o
  // engolisse, a proteção só valeria entre arquivos.
  const buf = Buffer.from(`${JSON.stringify({ 1: 'um', 2: 'dois' }, null, 1)}\n`);
  assert.throws(() => scanContentsBuffer(buf, () => { throw new Error('parei'); }), /parei/);
});

test('scanContentsBuffer: arquivo MINIFICADO (fora do layout) cai no JSON.parse completo', () => {
  const buf = Buffer.from(JSON.stringify({ 1: 'um', 2: 'dois' }));
  const seen = new Map();
  assert.equal(scanContentsBuffer(buf, (id, b) => seen.set(id, b)), 2);
  assert.equal(seen.get(2), 'dois');
});

// ---- riqueza ----

test('metaRichness: resumo+tags pesam mais que qualquer campo isolado', () => {
  const pobre = metaRichness({ title_pt: 'x', verify_status: 'ok', date_iso: '2026-01-01', snippet: 's' });
  const rico = metaRichness({ summary_pt: 'r', tags: { domain: ['web'] } });
  assert.ok(rico > pobre, `rico(${rico}) deve vencer pobre(${pobre})`);
  assert.equal(metaRichness({ tags: {} }), 0, 'tags vazias não contam');
  assert.equal(metaRichness({ tags: { domain: [] } }), 0);
});

test('merge por riqueza: EMPATE de riqueza fica com o snapshot MAIS NOVO', () => {
  // /empate tem a MESMA riqueza nos dois snapshots (só date_iso + snippet) e títulos diferentes.
  // É o único teste que separa `score > rec.score` de `score >= rec.score`: com `>=`, o snapshot
  // ANTIGO (varrido depois) sobrescreveria o novo e o título voltaria a 'T VELHO'.
  const { records } = collectFromGit({ root: BODYFIX.root, bodies: false });
  const rec = records.find((r) => r.url === 'https://ex.test/empate');
  assert.equal(metaRichness({ date_iso: '2026-03-01', snippet: 's' }), 2, 'as duas linhas empatam em 2');
  assert.equal(rec.title, 'T NOVO');
  assert.equal(rec.from, 'working tree', 'o vencedor é o snapshot mais novo da varredura');
});

// ---- coleta: união, os dois formatos, riqueza e ids ----

test('collectFromGit: une o histórico, lê os DOIS formatos de contents e mescla pela RIQUEZA', () => {
  const { records, report } = collectFromGit({ root: FIX.root });
  const byUrl = new Map(records.map((r) => [r.url, r]));

  assert.equal(report.commits, 2);
  assert.equal(report.articles, 4, '/a /b /c /d — a união é MAIOR que qualquer snapshot isolado');
  assert.equal(report.withBody, 4);
  assert.equal(report.bodiesFromParts, 2, '/a e /d vêm do formato NOVO (contents.partN.json)');
  assert.equal(report.bodiesFromLegacy, 2, '/b e /c vêm do formato LEGADO (contents.json)');

  // RIQUEZA vence RECÊNCIA: o snapshot mais novo tem /a POBRE; o registro rico do antigo ganha.
  const a = byUrl.get('https://ex.test/a');
  assert.equal(a.title, 'A RICO');
  assert.equal(a.summary_pt, 'resumo rico de a');
  assert.deepEqual(a.tags, { domain: ['web'], 'topic-technology': ['node'] });
  // …mas o CORPO é resolvido à parte (bodyPolicy): aqui o mais novo é TAMBÉM o de maior
  // substância, então 'best' e 'first' concordam — quem os separa é o fixture BODYFIX.
  assert.equal(a.content, 'corpo NOVO de a, mais longo');
  assert.equal(a.source_name, 'Fonte Um', 'source_id do snapshot é remapeado por NOME via meta');

  // IDENTIDADE: só o snapshot MAIS NOVO dita ids.
  assert.equal(a.id, 1);
  assert.equal(byUrl.get('https://ex.test/d').id, 2);
  assert.equal(byUrl.get('https://ex.test/b').id, null, 'id 2 do snapshot ANTIGO é de /d hoje');
  assert.equal(byUrl.get('https://ex.test/c').id, null);
  assert.equal(report.fromNewest, 2);
});

// ---- política de CORPO (o corpo mais novo NÃO é o melhor: 916 casos medidos no acervo) ----

const bodyOf = (records, slug) => records.find((r) => r.url === `https://ex.test/${slug}`)?.content;

test('bodyPolicy "best" (default): o corpo do snapshot ANTIGO vence quando o novo é o lixo', () => {
  const { records, report } = collectFromGit({ root: BODYFIX.root });
  assert.equal(report.bodyPolicy, 'best', 'default vem do config (CRAWLER_RESTORE_BODY_POLICY)');
  // o caso do CHANGELOG do vite: 8 caracteres no snapshot novo contra o changelog inteiro
  assert.equal(bodyOf(records, 'vite'), LONG_BODY);
  assert.ok(LONG_BODY.length > 4000 && 'Vite 8.2'.length === 8);
});

test('bodyPolicy "first": mantém o corpo do MAIS NOVO — e é por isso que ela perde conteúdo', () => {
  const { records } = collectFromGit({ root: BODYFIX.root, bodyPolicy: 'first' });
  // MESMO fixture, política diferente, resultado OPOSTO: sem isto, 'best'/'longest' poderiam
  // estar desligados e o teste de política ainda passaria (o mutante que sobreviveu).
  assert.equal(bodyOf(records, 'vite'), 'Vite 8.2');
  assert.equal(bodyOf(records, 'html'), CLEAN_BODY);
  assert.equal(bodyOf(records, 'espaco'), CLEAN_BODY);
});

test('bodyPolicy "best": HTML CRU perde para texto, mesmo sendo MAIOR (guard do "HTML na UI")', () => {
  const best = collectFromGit({ root: BODYFIX.root });
  assert.equal(bodyOf(best.records, 'html'), CLEAN_BODY, 'texto limpo vence a marcação');
  assert.equal(best.report.bodiesRejectedHtml, 1);
  // 'longest' é o contraste: sem sanidade nenhuma, o HTML cru (maior) entraria na base.
  const raw = collectFromGit({ root: BODYFIX.root, bodyPolicy: 'longest' });
  assert.equal(bodyOf(raw.records, 'html'), RAW_HTML_BODY);
  assert.ok(RAW_HTML_BODY.length > CLEAN_BODY.length);
});

test('bodyPolicy "best": corpo maior só em LINHAS EM BRANCO empata e o desempate fica com o novo', () => {
  const best = collectFromGit({ root: BODYFIX.root });
  assert.equal(bodyOf(best.records, 'espaco'), CLEAN_BODY, 'mesma substância => vence o mais novo');
  const raw = collectFromGit({ root: BODYFIX.root, bodyPolicy: 'longest' });
  assert.equal(bodyOf(raw.records, 'espaco'), SPACED_BODY, '"maior em bytes" traria só os brancos');
  assert.ok(SPACED_BODY.length > CLEAN_BODY.length);
  assert.equal(substanceLength(SPACED_BODY), substanceLength(CLEAN_BODY));
});

test('bodyPolicy: valor desconhecido cai no default "best" com aviso (fail-open)', () => {
  const { records, report } = collectFromGit({ root: BODYFIX.root, bodyPolicy: 'inventada' });
  assert.equal(report.bodyPolicy, 'best');
  assert.equal(bodyOf(records, 'vite'), LONG_BODY);
});

test('looksLikeRawHtml: precisão — artigo técnico com EXEMPLO DE CÓDIGO não é HTML cru', () => {
  assert.equal(looksLikeRawHtml(RAW_HTML_BODY), true);
  assert.equal(looksLikeRawHtml(`${LONG_BODY}\nuse <br> para quebrar linha e </p> fecha o parágrafo`), false);
  // O falso-positivo MEDIDO no acervo (52 artigos): prosa cheia de exemplo de JSX/HTML. Só a
  // densidade de tags marcava todos eles — e o corpo alternativo tinha 79 caracteres.
  const comCodigo = `Este post explica o componente. ${'<div className="x"><span>{item}</span></div>\ne o texto segue explicando o exemplo acima com detalhes suficientes para virar prosa de verdade.\n'.repeat(30)}`;
  assert.ok((comCodigo.match(/<\/?[a-z]/gi) || []).length > 100, 'tem MAIS de 100 tags…');
  assert.equal(looksLikeRawHtml(comCodigo), false, '…e mesmo assim NÃO é HTML cru (começa em prosa)');
  assert.equal(looksLikeRawHtml(CLEAN_BODY), false);
  assert.equal(looksLikeRawHtml(''), false);
  assert.equal(looksLikeRawHtml(null), false);
});

test('substanceLength: espaços em sequência valem por um', () => {
  assert.equal(substanceLength('a  \n\n b'), 3);
  assert.equal(substanceLength(''), 0);
  assert.equal(substanceLength(null), 0);
});

test('collectFromGit: fora de repo git devolve vazio sem lançar (fail-open)', () => {
  const { records, report } = collectFromGit({ root: tmpdir('nc-nogit-') });
  assert.equal(records.length, 0);
  assert.equal(report.repo, false);
  assert.equal(report.commits, 0);
});

// ---- aplicação na base ----

test('restoreFromGit: preserva os ids do snapshot novo e aloca ids NOVOS sem colisão', () => {
  wipeAll();
  const res = restoreFromGit({ root: FIX.root });
  assert.equal(res.selected, 4);
  assert.equal(res.inserted, 4);
  assert.equal(res.keptId, 2, '/a e /d entram com o id do snapshot mais novo');
  assert.equal(res.freshId, 2, '/b e /c ganham ids novos');

  const byUrl = (u) => db.prepare('SELECT id, url, title, summary_pt, content, blurb FROM articles WHERE url = ?').get(u);
  assert.equal(byUrl('https://ex.test/a').id, 1);
  assert.equal(byUrl('https://ex.test/d').id, 2);
  // acima do MAIOR id do snapshot novo (2) — zero colisão com os ids autoritativos
  assert.ok(byUrl('https://ex.test/b').id > 2, 'id novo fica acima do maior id do snapshot');
  assert.ok(byUrl('https://ex.test/c').id > 2);
  assert.equal(new Set([1, 2, byUrl('https://ex.test/b').id, byUrl('https://ex.test/c').id]).size, 4);

  // conteúdo e metadados vieram do merge por riqueza
  assert.equal(byUrl('https://ex.test/a').title, 'A RICO');
  assert.equal(byUrl('https://ex.test/a').summary_pt, 'resumo rico de a');
  assert.equal(byUrl('https://ex.test/a').content, 'corpo NOVO de a, mais longo');
  assert.equal(byUrl('https://ex.test/a').blurb, null, 'com corpo, o snippet NÃO vira blurb');

  // frontier: toda URL restaurada vira território conhecido (senão o próximo crawl re-descobre)
  assert.equal(res.frontier, 4);
  assert.equal(stmts.countFrontierByState.all().find((r) => r.state === 'done').c, 4);
  // fonte remapeada por nome (o source_id do snapshot é de outra base)
  assert.equal(res.sources, 1);
  assert.equal(stmts.getSourceByName.get('Fonte Um').id, byUrl('https://ex.test/a').id && stmts.getArticleFullByUrl.get('https://ex.test/a').source_id);
});

test('restoreFromGit: markClassified evita o re-classify de TODO o acervo restaurado', () => {
  // (a base é a do teste anterior — 4 artigos já restaurados)
  // Sem markClassified o sweep re-selecionaria os 4; com ele sobra só /c, que NUNCA teve tag em
  // snapshot nenhum (é classificação de verdade a fazer, não re-trabalho pago duas vezes).
  const pendentes = stmts.listArticlesNeedingClassification.all(1000);
  assert.equal(pendentes.length, 1);
  assert.equal(pendentes[0].url, 'https://ex.test/c');
  assert.equal(stmts.countClassifications.get().c, 3, 'só os 3 registros COM tags ganham a linha');
  assert.equal(stmts.getClassification.get(stmts.getArticleFullByUrl.get('https://ex.test/c').id), undefined,
    'artigo SEM tags no snapshot fica sem classificação — o sweep ainda o alcança (e não é carimbado)');
  const cls = stmts.getClassification.get(1);
  assert.equal(cls.status, 'restored');
  assert.equal(cls.model_used, 'restore', 'rótulo EXPLÍCITO: nunca se passa por classificação real');
  assert.equal(stmts.countArticleTags.get().c, 4, '2 tags de /a + 1 de /b + 1 de /d');
});

test('restoreFromGit: 2ª passada é 100% idempotente (não duplica, não re-escreve)', () => {
  const before = JSON.stringify({
    a: stmts.countArticles.get().c, t: stmts.countArticleTags.get().c,
    c: stmts.countClassifications.get().c, f: stmts.countFrontier.get().c,
  });
  const res = restoreFromGit({ root: FIX.root });
  assert.equal(res.inserted, 0);
  assert.equal(res.tags, 0);
  assert.equal(res.classifications, 0);
  assert.equal(res.frontier, 0);
  assert.deepEqual(res.skippedRows, { url: 4 });
  const after = JSON.stringify({
    a: stmts.countArticles.get().c, t: stmts.countArticleTags.get().c,
    c: stmts.countClassifications.get().c, f: stmts.countFrontier.get().c,
  });
  assert.equal(after, before);
});

test('restoreFromGit: dryRun não escreve nada', () => {
  wipeAll();
  const res = restoreFromGit({ root: FIX.root, dryRun: true });
  assert.equal(res.dryRun, true);
  assert.equal(res.selected, 4);
  assert.equal(res.keptId + res.freshId, 4);
  assert.equal(countArticles(), 0);
});

test('restoreFromGit: --limit e --since recortam o que é reposto', () => {
  wipeAll();
  assert.equal(restoreFromGit({ root: FIX.root, limit: 2 }).inserted, 2);
  wipeAll();
  assert.equal(restoreFromGit({ root: FIX.root, since: '2027-01-01' }).selected, 0);
  assert.equal(countArticles(), 0);
});

test('restoreFromGit: TUDO numa transação só — um erro no meio não deixa base pela metade', () => {
  wipeAll();
  // Trigger que aborta a partir da 3ª linha: sem transação única, 2 artigos sobreviveriam.
  db.exec(`CREATE TRIGGER nc_boom BEFORE INSERT ON articles
             WHEN (SELECT COUNT(*) FROM articles) >= 2
             BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  try {
    assert.throws(() => restoreFromGit({ root: FIX.root }), /boom/);
  } finally {
    db.exec('DROP TRIGGER nc_boom');
  }
  assert.equal(countArticles(), 0, 'rollback total: nem as 2 primeiras linhas ficaram');
  assert.equal(stmts.countFrontier.get().c, 0);
});

// ---- marcador de wipe (o que faz o `reset` continuar funcionando) ----

test('marcador de wipe: o restore IGNORA os commits anteriores à fronteira', () => {
  // Sem marcador: a união traz os 4 (inclusive /b e /c, exclusivos do commit ANTIGO).
  assert.equal(collectFromGit({ root: FIX.root }).records.length, 4);

  // Fronteira no commit ANTIGO: tudo ancestral-ou-igual a ele some (/b e /c).
  const marker = writeWipeMarker({ root: FIX.root, reason: 'reset', commit: FIX.commitA, articles: 3 });
  assert.ok(marker && marker.entry.commit === FIX.commitA);
  try {
    const { records, report } = collectFromGit({ root: FIX.root });
    assert.equal(report.commits, 1, 'só o commit posterior à fronteira é lido');
    assert.deepEqual(records.map((r) => r.url).sort(), ['https://ex.test/a', 'https://ex.test/d']);
    assert.equal(records.length, 2, '/b e /c NÃO ressuscitam');
    assert.equal(report.wipe.entries, 1);

    // `marker: false` desliga a fronteira explicitamente (auditoria/recuperação manual).
    assert.equal(collectFromGit({ root: FIX.root, marker: false }).records.length, 4);
  } finally {
    rmSync(path.join(FIX.root, WIPE_MARKER_FILE), { force: true });
  }
});

test('marcador de wipe: fronteira NO TOPO zera o restore (o `reset` de verdade apaga)', () => {
  writeWipeMarker({ root: FIX.root, commit: FIX.commitB, at: '2099-01-01T00:00:00.000Z' });
  try {
    const { records, report } = collectFromGit({ root: FIX.root });
    assert.equal(report.commits, 0);
    // o working tree também é anterior ao wipe (meta.generatedAt <= at) e é descartado
    assert.equal(records.length, 0, 'sem isto, `git rm` + histórico ressuscitariam o acervo apagado');
    assert.equal(maybeAutoRestore({ root: FIX.root, force: true }).skipped, 'no-snapshot');
  } finally {
    rmSync(path.join(FIX.root, WIPE_MARKER_FILE), { force: true });
  }
});

test('marcador de wipe: commit desconhecido no clone cai no fallback por DATA', () => {
  writeWipeMarker({
    root: FIX.root, commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    at: new Date(Date.now() + 86400000).toISOString(),
  });
  try {
    const { report } = collectFromGit({ root: FIX.root });
    assert.equal(report.commits, 0, 'sem o commit, a DATA do marcador vira a fronteira');
  } finally {
    rmSync(path.join(FIX.root, WIPE_MARKER_FILE), { force: true });
  }
});

test('marcador de wipe: arquivo corrompido é fail-open (não vira fronteira nem lança)', () => {
  writeFileSync(path.join(FIX.root, WIPE_MARKER_FILE), '{ isto não é json');
  try {
    assert.equal(readWipeMarker(FIX.root), null);
    assert.equal(collectFromGit({ root: FIX.root }).records.length, 4);
  } finally {
    rmSync(path.join(FIX.root, WIPE_MARKER_FILE), { force: true });
  }
});

test('writeWipeMarker: ACUMULA entradas (cada wipe é uma fronteira e todas valem)', () => {
  writeWipeMarker({ root: FIX.root, commit: FIX.commitA, at: '2026-01-15T00:00:00.000Z' });
  const second = writeWipeMarker({ root: FIX.root, commit: FIX.commitB, at: '2026-02-15T00:00:00.000Z' });
  try {
    assert.equal(second.entries.length, 2);
    const m = readWipeMarker(FIX.root);
    assert.equal(m.entries.length, 2);
    assert.deepEqual(m.commits, [FIX.commitA, FIX.commitB]);
    assert.equal(m.at, '2026-02-15T00:00:00.000Z', '`at` é a MAIOR data registrada');
  } finally {
    rmSync(path.join(FIX.root, WIPE_MARKER_FILE), { force: true });
  }
});

// ---- marcador de wipe x REESCRITA DE HISTÓRICO (rebase) ----

// Repo com a cadeia REAL: snapshot antigo -> WIPE (marcador + `git rm` do snapshot) -> acervo
// novo. `markerKind: 'v1'` escreve o marcador no formato ANTIGO (só commit+at, sem authorAt/
// snapshotAt) para provar que um marcador já gravado em disco continua valendo depois do rebase.
function buildWipedRepo(markerKind) {
  const root = tmpdir(`nc-wipe-${markerKind}-`);
  git(root, ['init', '-b', 'main', '-q']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['config', 'user.email', 'test@example.com']);

  writeSnapshot(root, {
    generatedAt: '2026-01-01T00:00:00.000Z',
    sources: SRC,
    articles: [snapRow(1, 'https://ex.test/old')],
    contents: { 1: 'corpo de old' },
  });
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--no-verify', '-m', 'snapshot antigo'], '2026-01-01T00:00:00 +0000');
  const wiped = git(root, ['rev-parse', 'HEAD']);

  // O WIPE: marcador na raiz + `git rm` do snapshot, tudo num commit (é o que o reset faz).
  const at = '2026-02-01T00:00:00.000Z';
  if (markerKind === 'v1') {
    writeFileSync(path.join(root, WIPE_MARKER_FILE), `${JSON.stringify({ version: 1, wipes: [{ at, commit: wiped }] }, null, 1)}\n`);
  } else {
    writeWipeMarker({ root, commit: wiped, at, reason: 'reset', articles: 1 });
  }
  git(root, ['rm', '-r', '-q', DATA]);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--no-verify', '-m', 'reset: apaga o acervo'], '2026-02-01T00:00:00 +0000');

  // Depois do wipe o acervo volta a crescer — este é o dado que o restore PRECISA trazer.
  writeSnapshot(root, {
    generatedAt: '2026-03-01T00:00:00.000Z',
    sources: SRC,
    articles: [snapRow(1, 'https://ex.test/b'), snapRow(2, 'https://ex.test/c')],
    contents: { 1: 'corpo de b', 2: 'corpo de c' },
  });
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--no-verify', '-m', 'acervo novo'], '2026-03-01T00:00:00 +0000');
  return { root, wiped };
}

function revGone(root, sha) {
  try {
    git(root, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
    return false;
  } catch {
    return true;
  }
}

for (const kind of ['v1', 'v2']) {
  test(`marcador de wipe (${kind}): um REBASE não pode ressuscitar o que o wipe apagou`, (t) => {
    // O rebase é a cadeia NATURAL, não exótica: o próprio `deploy` manda `pull --rebase` quando o
    // remoto está à frente. Ele REESCREVE o commit do marcador, e é aí que a fronteira antiga
    // caía: `^sha` deixa de cobrir os commits reescritos e o fallback por `%cI` (data de COMMIT)
    // vira inútil, porque o rebase carimba "agora" em TODO o histórico — nada mais é `<= at` e o
    // artigo apagado VOLTAVA. `%aI` e o `generatedAt` do snapshot não se mexem.
    const { root, wiped } = buildWipedRepo(kind);
    const KEEP = ['https://ex.test/b', 'https://ex.test/c'];
    const urls = (r) => collectFromGit({ root: r }).records.map((x) => x.url).sort();
    assert.deepEqual(urls(root), KEEP, 'antes do rebase');

    const headBefore = git(root, ['rev-parse', 'HEAD']);
    git(root, ['rebase', '--root', '--force-rebase', '-q']);
    assert.notEqual(git(root, ['rev-parse', 'HEAD']), headBefore, 'o rebase reescreveu o histórico');

    // (1) No PRÓPRIO repo o sha do marcador ainda RESOLVE (fica pendurado no reflog), mas a
    // linhagem dele não cobre mais os commits reescritos — quem segura a fronteira é o
    // `generatedAt` do snapshot.
    assert.equal(revGone(root, wiped), false, 'no repo rebaseado o sha antigo ainda está no odb');
    assert.deepEqual(urls(root), KEEP, 'DEPOIS do rebase, no mesmo repo: /old NÃO ressuscita');

    // (2) Num CLONE do repo reescrito o sha some de vez (objeto inalcançável não é clonado) e o
    // código cai no fallback por data — o caso em que `%cI` deixava tudo passar.
    const clone = path.join(tmpdir('nc-rebase-clone-'), 'c');
    git(path.dirname(clone), ['clone', '-q', `file://${root}`, clone]);
    assert.equal(revGone(clone, wiped), true, 'no clone o commit do marcador NÃO existe');
    assert.deepEqual(urls(clone), KEEP, 'DEPOIS do rebase, em clone novo: /old NÃO ressuscita');
    t.diagnostic(`marcador ${kind}: fronteira mantida com o sha ${wiped.slice(0, 8)} ausente do clone`);
  });
}

// ---- clone raso ----

test('clone RASO (--depth 1): degrada para o working tree com aviso, não falha', (t) => {
  const target = path.join(tmpdir('nc-shallow-'), 'clone');
  try {
    git(path.dirname(target), ['clone', '--depth', '1', '-q', `file://${FIX.root}`, target]);
  } catch {
    t.skip('git clone --depth 1 local indisponível neste ambiente');
    return;
  }
  assert.equal(isShallowRepo(target), true);
  const { records, report } = collectFromGit({ root: target });
  assert.equal(report.shallow, true);
  assert.equal(report.commits, 0, 'sem histórico: nenhum commit de dados é lido');
  // o working tree do clone é o snapshot MAIS NOVO — 2 artigos, não os 4 da união
  assert.deepEqual(records.map((r) => r.url).sort(), ['https://ex.test/a', 'https://ex.test/d']);
  assert.equal(records.find((r) => r.url === 'https://ex.test/a').content, 'corpo NOVO de a, mais longo');
});

// ---- orçamento de memória (o bootstrap não pode morrer com FATAL do V8) ----

test('memória: sem heap para os CORPOS, degrada para metadados com aviso (nunca estoura)', () => {
  // `FATAL ERROR: Reached heap limit` é um ABORT do V8 — o try/catch do maybeAutoRestore não o
  // captura. Snapshot com ~8 MB de corpos e um teto de heap de 3 MB: a fase de corpos nem começa.
  const root = tmpdir('nc-mem-');
  git(root, ['init', '-b', 'main', '-q']);
  const map = {};
  const articles = [];
  const body = 'y'.repeat(8000);
  for (let i = 1; i <= 1000; i += 1) {
    map[i] = `${body}${i}`;
    articles.push(snapRow(i, `https://ex.test/m${i}`));
  }
  writeSnapshot(root, {
    generatedAt: '2026-04-01T00:00:00.000Z',
    sources: SRC,
    articles,
    parts: [{ file: 'contents.part0.json', from: 1, to: 1000, map }],
  });

  const tight = collectFromGit({ root, heapLimitBytes: process.memoryUsage().heapUsed + 3 * 1048576 });
  assert.equal(tight.records.length, 1000, 'os METADADOS (resumo/tags/classificação) vêm inteiros');
  assert.equal(tight.report.memory.skippedBodies, true);
  assert.ok(tight.report.memory.needMb >= 8, `estimativa ~${tight.report.memory.needMb} MB`);
  assert.equal(tight.report.withBody, 0, 'nenhum corpo — e nenhum FATAL');
  assert.ok(tight.records.every((r) => r.snippet), 'o snippet vira blurb: a ficha não fica em branco');

  // com heap de sobra a MESMA coleta traz tudo (a degradação é proporcional, não permanente)
  const full = collectFromGit({ root });
  assert.equal(full.report.withBody, 1000);
  assert.equal(full.report.memory.skippedBodies, false);
  assert.equal(full.report.memory.stoppedAt, null);
  assert.ok(full.report.peakHeapMb >= 0 && full.report.memory.heapLimitMb > 0, 'o relatório carrega o orçamento');
});

test('memória: sem heap nem para os METADADOS, para no snapshot em que está (newest-first)', () => {
  // Teto de 1 byte: a varredura para depois do primeiro snapshot em vez de parsear o próximo
  // articles.json. Como a ordem é do mais novo para o mais antigo, o que sobra é o que mais vale.
  const { records, report } = collectFromGit({ root: FIX.root, heapLimitBytes: 1 });
  assert.equal(report.memory.stoppedAt, 'metadata');
  assert.deepEqual(records.map((r) => r.url).sort(), ['https://ex.test/a', 'https://ex.test/d']);
  assert.equal(report.memory.skippedBodies, true);
});

// ---- bootstrap automático ----

test('maybeAutoRestore NÃO dispara sob a suíte de testes (44 bancos tmp seriam populados)', () => {
  assert.equal(isUnderTest(), true, 'NODE_TEST_CONTEXT + NC_HOME em tmpdir');
  wipeAll();
  const res = maybeAutoRestore({ root: FIX.root });
  assert.equal(res.ran, false);
  assert.equal(res.skipped, 'test-env');
  assert.equal(countArticles(), 0);
});

test('isUnderTest: só sinais de RUNNER contam (NODE_ENV=test e NC_HOME em /tmp NÃO são teste)', () => {
  // Os dois falsos-positivos removidos. `NODE_ENV=test` exportado no shell (convenção de app,
  // não de runner) deixava o usuário SEM bootstrap; a regra "NC_HOME dentro de os.tmpdir()"
  // dependia do TMPDIR do processo (aqui os.tmpdir() é /var/tmp/user-1000, e um NC_HOME=/tmp/x
  // NÃO era detectado) — errava dos dois lados.
  const ctx = process.env.NODE_TEST_CONTEXT;
  const argv = process.argv;
  const home = process.env.NC_HOME; // sempre o tmpdir deste arquivo; o `||` abaixo é o cinto extra
  const nodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.NODE_TEST_CONTEXT;
    process.argv = ['/usr/bin/node', '/opt/app/bin/ncrawl.js', 'status'];
    process.env.NODE_ENV = 'test';
    process.env.NC_HOME = path.join(os.tmpdir(), 'nao-e-teste');
    assert.equal(isUnderTest(), false, 'nenhum sinal de runner: NÃO é teste');
    process.env.NODE_TEST_CONTEXT = 'child-v8';
    assert.equal(isUnderTest(), true, 'NODE_TEST_CONTEXT é o sinal inequívoco');
    delete process.env.NODE_TEST_CONTEXT;
    process.argv = ['/usr/bin/node', '--test', 'test/algo.test.js'];
    assert.equal(isUnderTest(), true);
  } finally {
    process.argv = argv;
    if (ctx === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = ctx;
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    // Restauração À PROVA DE undefined e válida TAMBÉM no caminho de exceção: se por qualquer
    // motivo o valor salvo não existir, o env volta para o tmpdir ISOLADO deste arquivo — em
    // nenhum caminho a suíte deixa NC_HOME falsy (= casa real do usuário).
    process.env.NC_HOME = home || NC_HOME_TMP;
  }
});

test('maybeAutoRestore: TODO pulo é LOGADO com o motivo (silêncio = bug indistinguível)', () => {
  const lines = [];
  setLogSink((entry) => lines.push(typeof entry === 'string' ? entry : entry?.text || ''));
  try {
    wipeAll();
    assert.equal(maybeAutoRestore({ root: FIX.root }).skipped, 'test-env');
    assert.equal(maybeAutoRestore({ root: FIX.root, enabled: false }).skipped, 'disabled');
    process.env.NC_NO_AUTO_RESTORE = '1';
    assert.equal(maybeAutoRestore({ root: FIX.root }).skipped, 'disabled-env');
  } finally {
    delete process.env.NC_NO_AUTO_RESTORE;
    setLogSink(null);
  }
  assert.equal(lines.length, 3, 'um pulo, uma linha');
  assert.match(lines[0], /suíte de testes/);
  assert.match(lines[1], /CRAWLER_AUTO_RESTORE=false/);
  assert.match(lines[2], /NC_NO_AUTO_RESTORE/);
});

test('maybeAutoRestore NÃO dispara em base NÃO-vazia (restore repõe, não sincroniza)', () => {
  wipeAll();
  const src = restoreSourceByName('Viva', 'https://viva.test');
  assert.equal(restoreArticle({ source_id: src.id, url: 'https://viva.test/1', content: 'vivo' }).inserted, true);
  const res = maybeAutoRestore({ root: FIX.root, force: true });
  assert.equal(res.ran, false);
  assert.equal(res.skipped, 'db-not-empty');
  assert.equal(countArticles(), 1, 'a base viva fica INTACTA');
});

test('maybeAutoRestore: CRAWLER_AUTO_RESTORE=false / --no-restore desliga', () => {
  wipeAll();
  assert.equal(maybeAutoRestore({ root: FIX.root, enabled: false }).skipped, 'disabled');
  assert.equal(countArticles(), 0);
});

test('maybeAutoRestore: base VAZIA + snapshot no git => restaura sozinho (o requisito do clone)', () => {
  wipeAll();
  const res = maybeAutoRestore({ root: FIX.root, force: true, quiet: true });
  assert.equal(res.ran, true);
  assert.equal(res.skipped, null);
  assert.equal(res.inserted, 4);
  assert.equal(countArticles(), 4);
  assert.equal(stmts.listArticlesNeedingClassification.all(1000).length, 1, 'só o artigo sem tags');
});

test('maybeAutoRestore: sem git / sem snapshot é fail-open (nunca derruba o comando)', () => {
  wipeAll();
  assert.equal(maybeAutoRestore({ root: tmpdir('nc-vazio-'), force: true }).skipped, 'no-git');
  assert.equal(countArticles(), 0);
});

// ---- contrato do `id` explícito no db.js (aditivo e retrocompatível) ----

test('restoreArticle: `local_id` é usado; o `id` CRU do snapshot segue ignorado', () => {
  wipeAll();
  const src = restoreSourceByName('Ids', 'https://ids.test');
  // `id` (campo do snapshot) continua sem efeito — é o contrato antigo, fixado em db.restore.test.js
  const cru = restoreArticle({ id: 999999, source_id: src.id, url: 'https://ids.test/cru', content: 'cru' });
  assert.notEqual(cru.id, 999999);
  assert.equal(restoreArticle({ local_id: 4242, source_id: src.id, url: 'https://ids.test/x', content: 'x' }).id, 4242);
  // o próximo id implícito nasce acima do explícito (INTEGER PRIMARY KEY = alias de rowid)
  const auto = restoreArticle({ source_id: src.id, url: 'https://ids.test/y', content: 'y' });
  assert.equal(auto.inserted, true);
  assert.ok(auto.id > 4242, `id implícito ${auto.id} deve ficar acima de 4242`);
});

test('restoreArticle: local_id já ocupado por OUTRA url devolve `id-taken` e não escreve', () => {
  const before = countArticles();
  const res = restoreArticle({ local_id: 4242, url: 'https://ids.test/outra', content: 'outra coisa' });
  assert.equal(res.inserted, false);
  assert.equal(res.reason, 'id-taken');
  assert.equal(res.id, null);
  assert.equal(countArticles(), before, 'nada foi escrito');
  // a MESMA url com o MESMO id é a 2ª passada idempotente, não uma colisão
  const again = restoreArticle({ local_id: 4242, url: 'https://ids.test/x', content: 'x' });
  assert.equal(again.reason, 'url');
  assert.equal(again.id, 4242);
});
