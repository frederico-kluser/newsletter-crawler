// Teste fail-closed do particionamento (`export --format web`): um ÚNICO artigo com custo
// serializado acima do TETO DURO (95 MB) NÃO pode ir sozinho numa parte — o GitHub rejeita blobs
// > 100 MB no push (GH001) — o export LANÇA erro citando id e tamanho, em vez de produzir uma
// parte gigante só com warn. NC_HOME isolado de propósito: o artigo gigante (~95 MB) contaminaria
// os testes do snapshot no export-web.test.js (targets de bytes minúsculos). Sem LLM/rede.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NC_HOME_TMP = mkdtempSync(path.join(tmpdir(), 'nc-export-web-hardcap-test-'));
process.env.NC_HOME = NC_HOME_TMP;

const { stmts, db } = await import('../src/db.js');
const { buildWebSnapshot } = await import('../src/export-web.js');

const src = stmts.upsertSource.get({ name: 'Fonte Gigante', base_url: 'http://gigante.test', type: 'index', max_index_pages: null });
// Corpo só de 'x' (1 byte/char no UTF-8, sem escapes no JSON): custo serializado passa do teto
// duro de 95 MB com pouco texto acima — mensagem de erro mostra ~95.0 MB.
const GIANT = 'x'.repeat(95 * 1024 * 1024 + 1024);
const r = stmts.insertArticle.run({
  source_id: src.id,
  url: 'http://gigante.test/artigo-gigante',
  title: 'Artigo gigante',
  content: GIANT,
  content_hash: 'hash-gigante',
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
const id = Number(r.lastInsertRowid);

after(() => {
  db.close();
  rmSync(NC_HOME_TMP, { recursive: true, force: true });
});

test('export web: artigo único acima do teto duro => THROW (fail-closed) citando id e tamanho', () => {
  assert.throws(
    () => buildWebSnapshot(),
    (err) => {
      // Mensagem clara: id do artigo + tamanho + o motivo (GH001) — nunca uma parte > teto duro.
      assert.match(err.message, new RegExp(`artigo ${id} tem ~95\\.0 MB sozinho`));
      assert.match(err.message, /acima do teto duro de 95 MB por parte/);
      assert.match(err.message, /GH001/);
      return true;
    },
    'artigo gigante não pode virar uma parte acima do teto duro (GH001)',
  );
});