// `upsertSource` completa a linha ÓRFÃ do restore (fonte recriada só pelo nome, base_url NULL)
// em vez de criar uma linha GÊMEA: sem isto os artigos legados ficavam numa linha e os novos em
// outra (fonte dividida — contagens, cursor e purge passam a mentir). Medido em 2026-10-03:
// as 5 fontes não-Cooperpress existiam só como rótulos e nunca eram semeadas.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-upsert-source-'));
const { upsertSource } = await import('../src/crawl.js');
const { db, stmts } = await import('../src/db.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

test('linha órfã do restore (só nome) é COMPLETADA — nunca duplicada', () => {
  const orphan = stmts.insertSourceByName.get({ name: 'The Rundown', base_url: null, type: 'listing' });
  assert.equal(orphan.base_url, null);

  const src = upsertSource({ url: 'https://www.therundown.ai/articles', name: 'The Rundown', type: 'listing' });
  assert.equal(src.id, orphan.id, 'a linha órfã deve receber o base_url (mesmo id)');
  assert.equal(src.base_url, 'https://www.therundown.ai/articles');
  const twins = db.prepare(`SELECT COUNT(*) c FROM sources WHERE name = 'The Rundown'`).get().c;
  assert.equal(twins, 1, 'não pode sobrar linha gêmea');
});

test('upsert repetido é idempotente e atualiza a mesma linha', () => {
  const a = upsertSource({ url: 'https://www.therundown.ai/articles', name: 'The Rundown', type: 'listing' });
  const b = upsertSource({ url: 'https://www.therundown.ai/articles', name: 'The Rundown', type: 'listing' });
  assert.equal(a.id, b.id);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM sources WHERE name = 'The Rundown'`).get().c, 1);
});

test('fonte nova (sem órfã) entra normalmente; nome de outra fonte viva não é tocado', () => {
  const s1 = upsertSource({ url: 'https://novafonte.test/feed', name: 'Nova', type: 'index' });
  assert.ok(s1.id);
  // Linha viva COM base_url de outro cadastro: o upsert não pode "roubar" o nome.
  stmts.insertSourceByName.get({ name: 'Nova', base_url: null, type: 'listing' }); // órfã homônima
  const s2 = upsertSource({ url: 'https://novafonte.test/feed', name: 'Nova', type: 'index' });
  assert.equal(s2.id, s1.id);
  const rows = db.prepare(`SELECT id, base_url FROM sources WHERE name = 'Nova' ORDER BY id`).all();
  assert.equal(rows.length, 2, 'a órfã homônima é um cadastro DISTINTO — não é fundida por nome');
  assert.equal(rows[0].base_url, 'https://novafonte.test/feed');
});
