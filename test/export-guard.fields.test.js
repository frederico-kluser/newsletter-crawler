// `issue_url` + `blurb` no snapshot do webapp e na API pública v1 (mudança ADITIVA). Por que os
// dois campos: sem eles um restore do acervo a partir do snapshot commitado não alimenta o 4º ramo
// do `stmts.isUrlKnown` (`articles.issue_url`) nem a parada determinística de paginação — e todo
// restore vira uma re-curadoria por IA de ~600 issues × 9 fontes (a fase mais cara do pipeline).
// Cobre: presença nos DOIS exports (snake_case no web, camelCase na API), null presente (nunca
// omitido), a REDAÇÃO de segredos nos campos novos e o fato de eles ficarem FORA do
// contents.partN.json (as partes já beiram o teto de 100 MB do GitHub). Sem LLM/rede.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-export-fields-test-'));
process.env.NC_HOME = NC_HOME_TMP;

const { stmts, db } = await import('../src/db.js');
const { buildWebSnapshot, exportWebSnapshot } = await import('../src/export-web.js');
const { buildPublicApi, exportPublicApi } = await import('../src/export-api.js');

const alpha = stmts.upsertSource.get({ name: 'Fonte Alpha', base_url: 'http://alpha.test', type: 'index', max_index_pages: null });
// 2ª fonte de propósito: a proveniência é varrida FONTE A FONTE (stmts.listArticlesBySource), então
// mais de uma fonte exercita o encadeamento dos iteradores.
const beta = stmts.upsertSource.get({ name: 'Fonte Beta', base_url: 'http://beta.test', type: 'listing', max_index_pages: null });

function seed({ url, title, content, issueUrl = null, blurb = null, source = alpha }) {
  const r = stmts.insertArticle.run({
    source_id: source.id,
    url,
    title,
    content,
    content_hash: `hash-${url}`,
    published_at: '2026-06-20',
    run_id: null,
    kind: 'news',
    issue_url: issueUrl,
    section: 'News',
    blurb,
    content_source: blurb ? 'aggregator' : 'target',
    cleaned: 0,
    needs_enrich: blurb ? 1 : 0,
  });
  return Number(r.lastInsertRowid);
}

// Item CURADO: veio de uma issue e carrega o blurb do agregador (o caso que o restore precisa).
const curado = seed({
  url: 'http://alpha.test/vitest-3',
  title: 'Vitest 3 released',
  content: 'Corpo extraído do alvo.',
  issueUrl: 'http://alpha.test/issues/778',
  blurb: 'O runner de testes chegou à v3, com foco em performance.',
});
// Item sem proveniência: os dois campos têm de sair PRESENTES com null.
const solto = seed({ url: 'http://alpha.test/solto', title: 'Sem issue', content: 'Corpo solto.' });
// Segredo no blurb E na URL da issue: a superfície pública é commitada, e um token real faria o
// Push Protection do GitHub rejeitar o push do snapshot inteiro.
const TOKEN = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;
const comSegredo = seed({
  url: 'http://alpha.test/vazou',
  title: 'Token de exemplo',
  content: 'Corpo qualquer.',
  issueUrl: `http://alpha.test/issues/779?token=${TOKEN}`,
  blurb: `Use o token ${TOKEN} para autenticar no exemplo.`,
});
// Item de OUTRA fonte: a proveniência tem de vir completa também p/ ele.
const outraFonte = seed({
  url: 'http://beta.test/artigo',
  title: 'Item da Beta',
  content: 'Corpo da Beta.',
  issueUrl: 'http://beta.test/edicao/12',
  blurb: 'Blurb da Beta.',
  source: beta,
});
// Item SEM FONTE (source_id NULO) — é o que o próprio snapshot produz quando um restore não
// consegue remapear a fonte (db.js documenta esse estado). A varredura por fonte que buscava a
// proveniência (listArticlesBySource, fonte a fonte) PULAVA exatamente este artigo: o ciclo
// restore → re-export descartava o issue_url/blurb de quem mais precisa deles.
const semFonte = seed({
  url: 'http://orfao.test/artigo',
  title: 'Item sem fonte',
  content: 'Corpo do órfão.',
  issueUrl: 'http://orfao.test/issues/9',
  blurb: 'Blurb do órfão.',
  source: { id: null },
});

// Blurb ENORME: nada no schema limita o campo, e ele passou a viajar num arquivo COMMITADO.
const BLURB_LONGO = `Início do blurb. ${'palavra '.repeat(2000)}fim.`;
const blurbudo = seed({
  url: 'http://alpha.test/blurb-longo',
  title: 'Item com blurb enorme',
  content: 'Corpo qualquer.',
  issueUrl: 'http://alpha.test/issues/780',
  blurb: BLURB_LONGO,
});

after(() => {
  db.close();
  rmSync(NC_HOME_TMP, { recursive: true, force: true });
});

test('snapshot web: articles.json traz issue_url e blurb (snake_case, como o restore lê)', () => {
  const { articles } = buildWebSnapshot();
  const a = articles.find((x) => x.id === curado);
  assert.equal(a.issue_url, 'http://alpha.test/issues/778');
  assert.equal(a.blurb, 'O runner de testes chegou à v3, com foco em performance.');

  const s = articles.find((x) => x.id === solto);
  assert.ok('issue_url' in s && 'blurb' in s, 'campo PRESENTE mesmo vazio (nunca omitido)');
  assert.equal(s.issue_url, null);
  assert.equal(s.blurb, null);

  const b = articles.find((x) => x.id === outraFonte);
  assert.equal(b.issue_url, 'http://beta.test/edicao/12', 'a varredura cobre TODAS as fontes');
  assert.equal(b.blurb, 'Blurb da Beta.');
});

test('artigo SEM fonte (source_id NULL) leva issue_url e blurb — web e API', async () => {
  const { buildWebSnapshot: build } = await import('../src/export-web.js');
  const web = build().articles.find((x) => x.id === semFonte);
  assert.equal(web.source_id, null);
  assert.equal(web.issue_url, 'http://orfao.test/issues/9');
  assert.equal(web.blurb, 'Blurb do órfão.');

  const api = buildPublicApi().articles.find((x) => x.id === semFonte);
  assert.equal(api.sourceId, null);
  assert.equal(api.sourceName, null);
  assert.equal(api.issueUrl, 'http://orfao.test/issues/9');
  assert.equal(api.blurb, 'Blurb do órfão.');
});

test('API v1: corpus.json traz issueUrl e blurb (camelCase, contrato aditivo)', () => {
  const { articles } = buildPublicApi();
  const a = articles.find((x) => x.id === curado);
  assert.equal(a.issueUrl, 'http://alpha.test/issues/778');
  assert.equal(a.blurb, 'O runner de testes chegou à v3, com foco em performance.');
  assert.ok(!('content' in a), 'a API pública segue sem o corpo completo');

  const s = articles.find((x) => x.id === solto);
  assert.equal(s.issueUrl, null);
  assert.equal(s.blurb, null);

  const b = articles.find((x) => x.id === outraFonte);
  assert.equal(b.issueUrl, 'http://beta.test/edicao/12');
  assert.equal(b.sourceName, 'Fonte Beta');
});

test('redação de segredos vale para os campos NOVOS (web e API)', () => {
  const web = buildWebSnapshot().articles.find((x) => x.id === comSegredo);
  assert.equal(web.blurb, 'Use o token [REDACTED] para autenticar no exemplo.');
  assert.equal(web.issue_url, 'http://alpha.test/issues/779?token=[REDACTED]');

  const api = buildPublicApi().articles.find((x) => x.id === comSegredo);
  assert.equal(api.blurb, 'Use o token [REDACTED] para autenticar no exemplo.');
  assert.equal(api.issueUrl, 'http://alpha.test/issues/779?token=[REDACTED]');
});

test('os campos novos vão em articles.json/corpus.json — NUNCA nos contents.partN.json', () => {
  const dir = path.join(NC_HOME_TMP, 'out');
  const apiDir = path.join(NC_HOME_TMP, 'api');
  const r = exportWebSnapshot({ outDir: dir });
  exportPublicApi({ outDir: apiDir });

  const artigos = readFileSync(path.join(dir, 'articles.json'), 'utf8');
  assert.ok(artigos.includes('"issue_url"') && artigos.includes('"blurb"'));
  assert.ok(artigos.includes('issues/778'));
  assert.ok(!artigos.includes(TOKEN), 'nenhum token cru viaja no arquivo commitado');

  for (const p of r.parts) {
    const parte = readFileSync(path.join(dir, p.file), 'utf8');
    assert.ok(!parte.includes('issue_url'), `${p.file} carrega só id→content`);
    assert.ok(!parte.includes('runner de testes'), `${p.file} não duplica o blurb`);
  }

  const corpus = readFileSync(path.join(apiDir, 'corpus.json'), 'utf8');
  assert.ok(corpus.includes('"issueUrl"') && corpus.includes('"blurb"'));
  assert.ok(!corpus.includes(TOKEN));
  JSON.parse(corpus);
});

test('snippet e blurb NUNCA viajam juntos: o mesmo texto não vai duas vezes no articles.json', async () => {
  const { snippetFromBlurb } = await import('../src/export-web.js');
  const articles = buildWebSnapshot().articles;
  for (const a of articles) {
    assert.ok(a.blurb == null || a.snippet == null, `artigo ${a.id} mandou snippet E blurb`);
    assert.ok('snippet' in a && 'blurb' in a, 'os dois campos ficam PRESENTES (um deles null)');
  }

  // COM blurb: o blurb é a fonte da verdade e o snippet se deriva dele (a regra do SQL).
  const a = articles.find((x) => x.id === curado);
  assert.equal(a.snippet, null);
  assert.equal(snippetFromBlurb(a.blurb), 'O runner de testes chegou à v3, com foco em performance.');
  // SEM blurb: o snippet continua vindo pronto (derivado do content).
  const s = articles.find((x) => x.id === solto);
  assert.equal(s.blurb, null);
  assert.equal(s.snippet, 'Corpo solto.');

  // A economia é real: mandar os dois inflaria o arquivo com o texto repetido.
  const dobrado = articles.reduce(
    (n, x) => n + (x.blurb ? Buffer.byteLength(JSON.stringify(snippetFromBlurb(x.blurb))) : 0),
    0,
  );
  assert.ok(dobrado > 0, 'o acervo de teste tem itens de agregador (senão o caso não é exercido)');
});

test('blurb tem TETO (4000 chars): um item patológico não infla o arquivo commitado', () => {
  const web = buildWebSnapshot().articles.find((x) => x.id === blurbudo);
  assert.equal(web.blurb.length, 4000);
  assert.ok(web.blurb.startsWith('Início do blurb. '), 'trunca o FIM, o começo é preservado');
  assert.equal(web.snippet, null, 'e o snippet continua derivado (nada duplicado)');

  const api = buildPublicApi().articles.find((x) => x.id === blurbudo);
  assert.equal(api.blurb.length, 4000);
  // Na API pública o `snippet` é `required` e não-nulo no contrato v1 PUBLICADO — segue SEMPRE
  // presente (por isso o corpus.json manda os dois; o snapshot interno, que vem com o leitor
  // junto, manda um OU outro).
  assert.equal(typeof api.snippet, 'string');
  assert.ok(api.snippet.startsWith('Início do blurb.'));
  assert.ok(api.snippet.length <= 400);
});

test('determinismo preservado: 2 exports seguidos geram articles.json byte-idêntico', () => {
  const d1 = path.join(NC_HOME_TMP, 'det1');
  const d2 = path.join(NC_HOME_TMP, 'det2');
  exportWebSnapshot({ outDir: d1 });
  exportWebSnapshot({ outDir: d2 });
  assert.equal(
    readFileSync(path.join(d1, 'articles.json'), 'utf8'),
    readFileSync(path.join(d2, 'articles.json'), 'utf8'),
  );
});
