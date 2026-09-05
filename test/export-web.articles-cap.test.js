// Teto DURO do articles.json (fail-closed), irmão do PART_HARD_CAP_MB das partes de contents. O
// particionamento protegia SÓ os contents.partN: o articles.json não tinha teto nenhum, e ele é
// COMMITADO a cada deploy — o GitHub rejeita blobs > 100 MB (GH001). Com os campos de proveniência
// ele passou de 1,87 p/ ~2,0 KB por artigo, o que põe o limite prático perto de 48 mil artigos (o
// acervo foi de 2.866 p/ 13.758 em dois meses). Sem guard, o estouro apareceria como um push
// rejeitado — depois do commit, longe da causa. Aqui ele aparece no export, com a saída acionável.
// NC_HOME isolado de propósito (o artigo gigante contaminaria os outros testes de snapshot).
// Sem LLM/rede.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-export-articles-cap-test-'));
process.env.NC_HOME = NC_HOME_TMP;

const { stmts, db } = await import('../src/db.js');
const { exportWebSnapshot } = await import('../src/export-web.js');

// O peso vai no TÍTULO: ele viaja em articles.json e NÃO no contents.partN (que tem teto próprio e
// dispararia antes). Só 'x' = 1 byte/char em UTF-8 e nenhum escape no JSON.
const src = stmts.upsertSource.get({ name: 'Fonte Gigante', base_url: 'http://gigante.test', type: 'index', max_index_pages: null });
stmts.insertArticle.run({
  source_id: src.id,
  url: 'http://gigante.test/titulo-gigante',
  title: 'x'.repeat(95 * 1024 * 1024 + 1024),
  content: 'corpo minúsculo',
  content_hash: 'hash-titulo-gigante',
  published_at: '2026-06-20',
  run_id: null,
  kind: null,
  issue_url: null,
  section: null,
  blurb: null,
  content_source: 'target',
  cleaned: 0,
  needs_enrich: 0,
});

after(() => {
  db.close();
  rmSync(NC_HOME_TMP, { recursive: true, force: true });
});

test('articles.json acima do teto duro => THROW (fail-closed) com saída acionável, e NADA escrito', () => {
  const dir = path.join(NC_HOME_TMP, 'out');
  assert.throws(
    () => exportWebSnapshot({ outDir: dir }),
    (err) => {
      assert.match(err.message, /articles\.json ficou com 95\.\d MB/);
      assert.match(err.message, /acima do teto duro de 95 MB/);
      assert.match(err.message, /GH001/); // o motivo REAL (o push seria rejeitado)
      assert.match(err.message, /FATIE o articles\.json/); // e o que fazer a respeito
      return true;
    },
  );
  // O teto é checado ANTES da escrita: nem os temporários chegam a existir.
  assert.deepEqual(readdirSync(dir), [], 'export abortado não deixa arquivo nenhum no outDir');
});
