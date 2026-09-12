// Cursor de captura POR FONTE — camada de DADOS (src/db.js): `sources.cursor_date`, o MAX
// normalizado do que a fonte já tem (`maxPublishedForSource`), o trabalho INACABADO que serve de
// teto ao piso (`oldestUnfinishedForSource`), o avanço que NUNCA retrocede (`advanceSourceCursor`)
// e os dois resets (`resetSourceCursor`/`resetAllSourceCursors`), mais o reset DENTRO da transação
// do `purgeSource`.
//
// O que está em jogo: `published_at` é string CRUA do scrape (ISO ou "Sep 9, 2026"), então o
// cursor só pode ser comparado depois do MESMO `iso_date` (parseDate -> YYYY-MM-DD) que o resto do
// banco usa. Um cursor gravado em formato diferente do consultado faria a fonte varrer o arquivo
// inteiro de novo (piso nunca "alcança") ou — pior — pular itens novos.
//
// Duas guardas de data que o cursor depende:
//  - `maxPublishedForSource` IGNORA DATA FUTURA (`iso_date(...) <= date('now')`, UTC): um item com
//    data-bomba (JSON-LD de "próxima edição", ano trocado) viraria piso e a fonte ficaria sem
//    capturar nada até essa data — e o cursor nunca retrocede, então era perda permanente.
//  - `oldestUnfinishedForSource` dá o teto do BACKLOG: pendência sem data derruba o piso ao mínimo
//    (o `SUM` devolve NULL sem linhas e o `applyPendingCeiling` tolera).
//
// TZ=UTC fixado ANTES dos imports: datas cruas SEM fuso ("Sep 9, 2026") são interpretadas no fuso
// LOCAL, e o `iso_date` responde em UTC — sem fixar o fuso a asserção literal passaria ou não
// dependendo da máquina. O processo do `node --test` é por ARQUIVO, então isto não vaza.
// As fixtures de MAX são RELATIVAS a hoje (`date('now')`): o teto de futuro é parte do contrato, e
// uma data fixa de 2026 deixaria de ser futuro (ou passaria a ser) com o tempo.
//
// NC_HOME em tmpdir ANTES de importar db (padrão do repo) — o banco real do usuário nunca é aberto.
process.env.TZ = 'UTC';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-db-cursor-'));
const { db, stmts, purgeSource } = await import('../src/db.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

// ---- relógio/formatos: hoje em UTC é a fronteira do "futuro" no MAX ----

const hojeUTC = () => db.prepare(`SELECT date('now') AS d`).get().d; // YYYY-MM-DD (UTC)

function shiftDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const MES_CURTO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MES_LONGO = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
/** 'YYYY-MM-DD' -> 'Sep 9, 2026' (o formato cru que o scrape entrega). */
const rawShort = (iso) => {
  const [y, m, d] = iso.split('-');
  return `${MES_CURTO[Number(m) - 1]} ${Number(d)}, ${y}`;
};
/** 'YYYY-MM-DD' -> 'September 9, 2026' (mês por extenso). */
const rawLong = (iso) => {
  const [y, m, d] = iso.split('-');
  return `${MES_LONGO[Number(m) - 1]} ${Number(d)}, ${y}`;
};

let seq = 0;
function newSource(name) {
  seq += 1;
  return stmts.upsertSource.get({
    name, base_url: `https://${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${seq}.example`,
    type: 'index', max_index_pages: null,
  });
}

/** Insere um artigo da fonte com o `published_at` CRU dado (string ou null), URL única. */
function addArticle(sourceId, publishedAt) {
  const url = `https://art.example/${++seq}`;
  stmts.insertArticle.run({
    source_id: sourceId, url, title: `Item ${seq}`, content: 'blurb do agregador',
    content_hash: `hash-${url}`, published_at: publishedAt, run_id: 1, kind: 'news',
    issue_url: null, section: null, blurb: 'blurb do agregador', content_source: 'aggregator',
    cleaned: 0, needs_enrich: 0,
  });
  return url;
}

const cursorOf = (id) => stmts.getSourceById.get(id).cursor_date;
const maxOf = (id) => stmts.maxPublishedForSource.get(id).d;

// ---- maxPublishedForSource: normalização de formatos + escopo por fonte ----

test('maxPublishedForSource: formatos VARIADOS viram o ISO do mais novo (por fonte)', () => {
  const hoje = hojeUTC();
  const recente = shiftDays(hoje, -3);
  const dezDias = shiftDays(hoje, -10);
  const quarenta = shiftDays(hoje, -40);

  const a = newSource('Mixed A');
  addArticle(a.id, recente);                     // ISO date-only (o mais novo)
  addArticle(a.id, `${recente}T15:30:00Z`);      // ISO com hora/fuso (mesmo dia UTC)
  addArticle(a.id, `${recente}T02:00:00-03:00`); // offset -03: -> 05:00Z, mesmo dia UTC
  addArticle(a.id, rawShort(dezDias));           // cru, mês abreviado
  addArticle(a.id, rawLong(quarenta));           // cru, mês por extenso
  assert.equal(maxOf(a.id), recente, 'o mais novo em UTC manda (compara instante, não string crua)');

  // Dois formatos do MESMO dia normalizam para o mesmo ISO (a dedup por data não depende do texto).
  const c = newSource('Mixed C');
  addArticle(c.id, rawShort(dezDias));
  addArticle(c.id, rawLong(dezDias));
  assert.match(maxOf(c.id), /^\d{4}-\d{2}-\d{2}$/, 'sempre YYYY-MM-DD, nunca a string crua');
  assert.equal(maxOf(c.id), dezDias);

  // Uma fonte mais nova NÃO contamina o MAX da outra.
  const b = newSource('Mixed B');
  const umDia = shiftDays(hoje, -1);
  addArticle(b.id, umDia);
  assert.equal(maxOf(b.id), umDia);
  assert.equal(maxOf(a.id), recente, 'MAX é escopado por source_id');
});

test('maxPublishedForSource: DATA FUTURA é ignorada (não vira piso nem pula o intervalo)', () => {
  const hoje = hojeUTC();
  const passado = shiftDays(hoje, -2);
  const futuro = shiftDays(hoje, +2); // relativo: continua futuro amanhã, e o teste não envelhece

  const s = newSource('Futuro');
  addArticle(s.id, passado);
  addArticle(s.id, futuro);
  addArticle(s.id, '2099-01-01');
  addArticle(s.id, rawLong('2099-01-01')); // data-bomba em formato cru também cai fora
  assert.equal(maxOf(s.id), passado, 'a fronteira é HOJE (UTC): o futuro não entra, o passado entra');

  const soFuturo = newSource('So futuro');
  addArticle(soFuturo.id, futuro);
  addArticle(soFuturo.id, '2099-01-01');
  assert.equal(maxOf(soFuturo.id), null, 'sem item não-futuro não há derivado (cai no piso mínimo)');

  const ontem = newSource('Ontem');
  addArticle(ontem.id, shiftDays(hoje, -1));
  assert.equal(maxOf(ontem.id), shiftDays(hoje, -1), 'ontem é passado e conta normalmente');
});

test('maxPublishedForSource: inparseável e NULL são ignorados; fonte sem data -> null', () => {
  const s = newSource('Lixo');
  addArticle(s.id, 'ontem');
  addArticle(s.id, null);
  addArticle(s.id, '');
  addArticle(s.id, '2026-13-45'); // mês/dia inexistentes: SQLite date() viraria NULL silencioso
  assert.equal(maxOf(s.id), null, 'nenhuma data válida -> NULL (não "hoje", não string vazia)');

  // Com uma válida no meio, o lixo continua fora e o MAX vem do válido.
  const valido = shiftDays(hojeUTC(), -5);
  addArticle(s.id, valido);
  assert.equal(maxOf(s.id), valido);

  const vazia = newSource('Sem artigos');
  assert.equal(maxOf(vazia.id), null);
});

test('maxPublishedForSource: uma fonte com datas antigas não enxerga a mais nova da vizinha', () => {
  const antiga = newSource('Antiga');
  addArticle(antiga.id, '2024-01-01');
  const nova = newSource('Nova');
  addArticle(nova.id, '2025-09-12');
  assert.equal(maxOf(antiga.id), '2024-01-01');
  assert.equal(maxOf(nova.id), '2025-09-12');
});

// ---- oldestUnfinishedForSource: teto do trabalho inacabado ----

test('oldestUnfinishedForSource: MIN das pendências datadas + contagem das SEM data', () => {
  const s = newSource('Backlog');
  const url = (n) => `https://backlog.example/i${n}`;

  stmts.enqueue.run(url(1), 'article', null, s.id, 0, '2025-08-01'); // pending datada
  stmts.enqueue.run(url(2), 'article', null, s.id, 0, '2025-08-20'); // pending datada (mais nova)
  stmts.enqueue.run(url(3), 'article', null, s.id, 0, '2025-07-15'); // in_progress conta como inacabado
  stmts.finish.run('in_progress', url(3));
  stmts.enqueue.run(url(4), 'article', null, s.id, 0, '2025-01-01'); // done: NÃO conta (mais antiga de todas)
  stmts.finish.run('done', url(4));
  stmts.enqueue.run(url(5), 'article', null, s.id, 0, null);         // pending SEM data -> undated
  stmts.enqueue.run(`${url(0)}-issues`, 'listing', null, s.id, 0, null); // listing: fora (re-enfileirado toda run)

  const r = stmts.oldestUnfinishedForSource.get(s.id);
  assert.equal(r.d, '2025-07-15', 'a pendência datada mais ANTIGA, in_progress incluído');
  assert.equal(r.undated, 1, 'só a pendência sem data — o listing não entra na conta');

  // Fonte sem nenhuma linha na frontier: o SUM agrega zero linhas e devolve NULL (o
  // applyPendingCeiling trata com `?? 0` — null NÃO pode virar "tem pendência sem data").
  const limpa = newSource('Backlog vazio');
  const vazio = stmts.oldestUnfinishedForSource.get(limpa.id);
  assert.equal(vazio.d, null);
  assert.equal(vazio.undated, null, 'SUM sem linhas é NULL, não 0');

  // Outra fonte não contamina (o filtro é source_id).
  assert.equal(stmts.oldestUnfinishedForSource.get(limpa.id).d, null);
});

test('oldestUnfinishedForSource: sem pendências datadas sobra o undated (piso cai no mínimo)', () => {
  const s = newSource('Backlog cego');
  stmts.enqueue.run('https://backlog.example/cego-1', 'article', null, s.id, 0, null);
  stmts.enqueue.run('https://backlog.example/cego-2', 'article', null, s.id, 0, null);
  stmts.enqueue.run('https://backlog.example/cego-3', 'article', null, s.id, 0, '2025-06-06');
  stmts.finish.run('failed', 'https://backlog.example/cego-3'); // failed: terminado, não é backlog
  const r = stmts.oldestUnfinishedForSource.get(s.id);
  assert.equal(r.d, null, 'nada datado pendente (failed não conta)');
  assert.equal(r.undated, 2);
});

// ---- advanceSourceCursor: só avança ----

test('advanceSourceCursor: avança, EMPATA e retrocede sem sair do lugar', () => {
  const s = newSource('Advance A');
  assert.equal(cursorOf(s.id), null, 'fonte nova nasce sem cursor');

  assert.equal(stmts.advanceSourceCursor.run({ id: s.id, date: '2025-09-10' }).changes, 1);
  assert.equal(cursorOf(s.id), '2025-09-10');

  assert.equal(stmts.advanceSourceCursor.run({ id: s.id, date: '2025-09-05' }).changes, 0, 'retroceder é no-op');
  assert.equal(cursorOf(s.id), '2025-09-10');

  assert.equal(stmts.advanceSourceCursor.run({ id: s.id, date: '2025-09-10' }).changes, 0, 'empate também é no-op');
  assert.equal(cursorOf(s.id), '2025-09-10');

  assert.equal(stmts.advanceSourceCursor.run({ id: s.id, date: '2025-10-01' }).changes, 1);
  assert.equal(cursorOf(s.id), '2025-10-01');

  assert.equal(stmts.advanceSourceCursor.run({ id: 999999, date: '2025-11-01' }).changes, 0, 'id inexistente: nada a fazer');
});

test('advanceSourceCursor: fluxo real do crawl (MAX da fonte -> cursor) é estável entre runs', () => {
  const s = newSource('Advance B');
  const dez = shiftDays(hojeUTC(), -20);
  const quinze = shiftDays(hojeUTC(), -15);
  const vinte = shiftDays(hojeUTC(), -20); // reusado abaixo como "item antigo"
  addArticle(s.id, rawShort(dez));
  addArticle(s.id, `${quinze}T10:00:00Z`);

  const max = maxOf(s.id);
  assert.equal(max, quinze);
  assert.equal(stmts.advanceSourceCursor.run({ id: s.id, date: max }).changes, 1);
  assert.equal(cursorOf(s.id), quinze);

  // 2ª run sem item novo: o MAX é o mesmo -> 0 changes, cursor intacto (idempotente).
  assert.equal(stmts.advanceSourceCursor.run({ id: s.id, date: maxOf(s.id) }).changes, 0);
  assert.equal(cursorOf(s.id), quinze);

  // Item novo mais recente: avança.
  const novo = shiftDays(hojeUTC(), -5);
  addArticle(s.id, novo);
  assert.equal(stmts.advanceSourceCursor.run({ id: s.id, date: maxOf(s.id) }).changes, 1);
  assert.equal(cursorOf(s.id), novo);

  // Re-captura de um item ANTIGO (backfill/reprocesso) não puxa o piso para trás.
  addArticle(s.id, shiftDays(hojeUTC(), -60));
  assert.equal(stmts.advanceSourceCursor.run({ id: s.id, date: vinte }).changes, 0);
  assert.equal(cursorOf(s.id), novo);
});

// ---- purgeSource: cursor zerado NA MESMA transação ----

test('purgeSource: apaga os dados, MANTÉM a fonte e zera o cursor (recaptura não é pulada)', () => {
  const s = newSource('Purge A');
  addArticle(s.id, '2025-09-20');
  addArticle(s.id, rawShort('2025-09-21'));
  stmts.advanceSourceCursor.run({ id: s.id, date: maxOf(s.id) });
  assert.equal(cursorOf(s.id), '2025-09-21');

  const counts = purgeSource(s.id);
  assert.equal(counts.articles, 2, 'os artigos da fonte foram apagados');
  assert.ok(stmts.getSourceById.get(s.id), 'a fonte CONTINUA cadastrada (purge != remove)');
  assert.equal(cursorOf(s.id), null, 'cursor zerado junto com os dados');
  assert.equal(maxOf(s.id), null, 'sem artigos o derivado também é null');

  // A prova de fogo: depois do purge, a recaptura do zero pode gravar um piso ANTIGO — se o
  // cursor tivesse sobrevivido, o avanço viraria no-op e a fonte ficaria presa no piso velho.
  addArticle(s.id, '2020-05-05');
  assert.equal(stmts.advanceSourceCursor.run({ id: s.id, date: maxOf(s.id) }).changes, 1);
  assert.equal(cursorOf(s.id), '2020-05-05');

  assert.equal(purgeSource(999999), null, 'fonte inexistente -> null (nada a apagar)');
});

// ---- resetSourceCursor / resetAllSourceCursors ----

test('resetSourceCursor zera UMA fonte; resetAllSourceCursors limpa todas', () => {
  const a = newSource('Reset A');
  const b = newSource('Reset B');
  for (const s of [a, b]) {
    addArticle(s.id, '2025-09-30');
    stmts.advanceSourceCursor.run({ id: s.id, date: '2025-09-30' });
  }
  assert.equal(cursorOf(a.id), '2025-09-30');
  assert.equal(cursorOf(b.id), '2025-09-30');

  assert.equal(stmts.resetSourceCursor.run(a.id).changes, 1);
  assert.equal(cursorOf(a.id), null, 'a fonte alvo volta a varrer do zero');
  assert.equal(cursorOf(b.id), '2025-09-30', 'a outra fonte não é tocada');

  assert.ok(stmts.resetAllSourceCursors.run().changes >= 1);
  assert.deepEqual(
    stmts.listSources.all().filter((s) => s.cursor_date !== null),
    [],
    'nenhuma fonte pode sobrar com cursor depois do reset global',
  );

  // Zera e volta a avançar normalmente.
  assert.equal(stmts.advanceSourceCursor.run({ id: b.id, date: '2025-09-30' }).changes, 1);
  assert.equal(cursorOf(b.id), '2025-09-30');
});
