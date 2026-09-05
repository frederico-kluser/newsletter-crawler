// ESCRITA ATÔMICA do snapshot (src/export-web.js). "Nenhum arquivo é tocado" era verdade só no
// caminho de BLOQUEIO: aprovado o export, os arquivos eram escritos in-place na ordem meta.json →
// articles.json → contents.partN, e uma exceção no meio (disco cheio, permissão, arquivo que virou
// diretório) deixava a árvore MEIO-ESCRITA e comitável — com o agravante de o meta.json novo
// (totals.articles ALTO) já estar no lugar sobre um articles.json velho, ENVENENANDO o próprio
// baseline do guard (ele lê totals.articles como high-water).
// Agora: tudo vai p/ temporários no próprio outDir e é promovido por rename, com o meta.json POR
// ÚLTIMO. Este teste cobre (1) o repro do revisor — articles.json somente-leitura — que agora
// TERMINA, e (2) uma falha forçada no meio da promoção, que deixa o meta.json ANTIGO e nenhum
// temporário para trás. NC_HOME → tmp ANTES dos imports dinâmicos. Sem LLM/rede.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-export-atomic-test-'));
process.env.NC_HOME = NC_HOME_TMP;

const { stmts, db } = await import('../src/db.js');
const { exportWebSnapshot } = await import('../src/export-web.js');

const alpha = stmts.upsertSource.get({ name: 'Fonte Alpha', base_url: 'http://alpha.test', type: 'index', max_index_pages: null });
let seq = 0;
function seed() {
  seq += 1;
  stmts.insertArticle.run({
    source_id: alpha.id,
    url: `http://alpha.test/a${seq}`,
    title: `Artigo ${seq}`,
    content: `Corpo ${seq}`,
    content_hash: `hash-${seq}`,
    published_at: '2026-06-20',
    run_id: null,
    kind: 'news',
    issue_url: 'http://alpha.test/issues/1',
    section: null,
    blurb: null,
    content_source: 'target',
    cleaned: 0,
    needs_enrich: 0,
  });
}

const readMeta = (dir) => JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const readArticles = (dir) => JSON.parse(readFileSync(path.join(dir, 'articles.json'), 'utf8'));
const temporarios = (dir) => readdirSync(dir).filter((f) => f.includes('.tmp-'));

after(() => {
  db.close();
  rmSync(NC_HOME_TMP, { recursive: true, force: true });
});

test('repro do revisor: articles.json SOMENTE-LEITURA não quebra mais o export (rename promove)', () => {
  const dir = path.join(NC_HOME_TMP, 'ro');
  seed();
  exportWebSnapshot({ outDir: dir }); // snapshot de 1 artigo
  assert.equal(readMeta(dir).totals.articles, 1);

  seed();
  seed(); // a base cresceu p/ 3 — o guard aprova (cresceu)
  chmodSync(path.join(dir, 'articles.json'), 0o444);
  const r = exportWebSnapshot({ outDir: dir });

  // Antes: writeFileSync estourava EACCES DEPOIS de o meta.json novo já estar escrito — meta com
  // 3, articles.json com 1. Agora o rename substitui a ENTRADA no diretório (a permissão do
  // arquivo antigo não impede) e a árvore fica COERENTE.
  assert.equal(r.articles, 3);
  assert.equal(readMeta(dir).totals.articles, 3);
  assert.equal(readArticles(dir).length, 3, 'meta e articles contam a MESMA coisa');
  assert.deepEqual(temporarios(dir), [], 'nenhum .tmp- sobrou no dir que o deploy commita');
});

test('falha no meio da promoção: meta.json fica ANTIGO (baseline íntegro) e não sobra temporário', () => {
  const dir = path.join(NC_HOME_TMP, 'boom');
  exportWebSnapshot({ outDir: dir }); // 3 artigos
  const metaAntes = readFileSync(path.join(dir, 'meta.json'), 'utf8');
  const artigosAntes = readFileSync(path.join(dir, 'articles.json'), 'utf8');
  assert.equal(JSON.parse(metaAntes).totals.articles, 3);

  // Sabotagem determinística: a parte de contents vira um DIRETÓRIO — o rename do temporário por
  // cima dela falha (EISDIR), no meio da promoção e ANTES do meta.json (que é o último).
  const parte = path.join(dir, 'contents.part0.json');
  rmSync(parte, { force: true });
  mkdirSync(parte);

  seed(); // 4 artigos: o snapshot novo é MAIOR (o guard aprova; quem falha é a escrita)
  assert.throws(() => exportWebSnapshot({ outDir: dir }), (e) => {
    assert.ok(!/SnapshotShrink/.test(e.name), 'a falha é de ESCRITA, não do guard');
    return true;
  });

  // O que importa: o meta.json — baseline high-water do guard — NÃO avançou para 4 por cima de um
  // articles.json velho. Byte-idêntico prova que ele nem foi reescrito (o generatedAt mudaria).
  assert.equal(readFileSync(path.join(dir, 'meta.json'), 'utf8'), metaAntes);
  assert.equal(readFileSync(path.join(dir, 'articles.json'), 'utf8'), artigosAntes);
  assert.equal(JSON.parse(metaAntes).totals.articles, 3, 'o próximo export ainda compara com 3');
  assert.deepEqual(temporarios(dir), [], 'temporários limpos mesmo na falha');
  assert.ok(statSync(parte).isDirectory(), 'a sabotagem seguiu de pé (a falha foi real)');
});

test('export normal: meta.json é o ÚLTIMO a ser promovido (ordem que protege o baseline)', () => {
  const dir = path.join(NC_HOME_TMP, 'ordem');
  const r = exportWebSnapshot({ outDir: dir });
  const meta = readMeta(dir);
  // Coerência do trio depois de um export bem-sucedido: meta, articles e as partes batem.
  assert.equal(meta.totals.articles, r.articles);
  assert.equal(readArticles(dir).length, r.articles);
  assert.deepEqual(meta.contentsParts, r.parts);
  for (const p of r.parts) JSON.parse(readFileSync(path.join(dir, p.file), 'utf8'));
  assert.deepEqual(temporarios(dir), []);
});
