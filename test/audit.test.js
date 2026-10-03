// Modo debug (`ncrawl audit`): as regras PURAS do relatório — classificação de erros de fetch,
// separação "pulado corretamente" × "perdido por colisão de conteúdo", agregado de skips de
// listagem, detecção de picos de data (data de captura no lugar da data real) e flags de saúde
// por fonte. Mais um trecho DB-backed: o `dupAttribution` da curadoria e um relatório real sobre
// uma base semeada (o contrato de isolamento: NC_HOME temporário ANTES do primeiro import).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.NC_HOME = mkdtempSync(path.join(os.tmpdir(), 'nc-audit-'));
const { classifyFetchError, dupBreakdown, listingSkipTotals, detectDateSpikes, sourceFlags, buildAuditReport, renderAudit } =
  await import('../src/audit.js');
const { dupAttribution } = await import('../src/curate.js');
const { db, stmts } = await import('../src/db.js');
const { sha256 } = await import('../src/util.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

test('classifyFetchError: DNS/conexão/SSL = alvo morto (re-tentar é inútil)', () => {
  assert.equal(classifyFetchError('getaddrinfo ENOTFOUND blog.toonk.com'), 'dead-target');
  assert.equal(classifyFetchError('page.goto: net::ERR_NAME_NOT_RESOLVED at https://x/y'), 'dead-target');
  assert.equal(classifyFetchError('page.goto: net::ERR_CONNECTION_REFUSED at https://x/y'), 'dead-target');
  assert.equal(classifyFetchError('connect ECONNREFUSED 91.98.198.236:443'), 'dead-target');
  assert.equal(classifyFetchError('page.goto: net::ERR_SSL_PROTOCOL_ERROR at https://x/y'), 'dead-target');
});

test('classifyFetchError: bloqueio, timeout, HTTP e resto ficam separados', () => {
  assert.equal(classifyFetchError('Request failed with status code 403 (Forbidden): GET x'), 'blocked');
  assert.equal(classifyFetchError('Timeout awaiting request'), 'timeout');
  assert.equal(classifyFetchError('Request failed with status code 500 (Internal)'), 'http');
  assert.equal(classifyFetchError('unexpected token in JSON'), 'other');
});

test('dupBreakdown: separa skip correto (URL conhecida) de perda por colisão de conteúdo', () => {
  const out = dupBreakdown([
    { url: 'https://a/1', by: 'url', twin: null, known_url: 1 },
    { url: 'https://a/2', by: 'hash', twin: 'https://b/2', known_url: 0 },
    { url: 'https://a/3', by: null, twin: null, known_url: 1 }, // evento legado, já capturado
    { url: 'https://a/4', by: null, twin: null, known_url: 0 }, // evento legado sem linha: perda
  ]);
  assert.equal(out.byUrl, 2);
  assert.equal(out.byHash, 1);
  assert.equal(out.legacy, 1);
  assert.equal(out.losses.length, 2);
  assert.deepEqual(out.losses.map((l) => l.url).sort(), ['https://a/2', 'https://a/4']);
  assert.equal(out.losses.find((l) => l.url === 'https://a/2').twin, 'https://b/2');
});

test('listingSkipTotals: pulados por já capturados = links − novos − abaixo do piso', () => {
  const { total, byListing } = listingSkipTotals([
    { url: 'https://x/issues', links: 100, novos: 3, abaixo: 90, page: 0 },
    { url: 'https://x/issues', links: 100, novos: 0, abaixo: 0, page: 1 },
    { url: 'https://y/issues', links: 50, novos: 5, abaixo: 40, page: 0 },
  ]);
  assert.equal(total.links, 250);
  assert.equal(total.novos, 8);
  assert.equal(total.abaixo, 130);
  assert.equal(total.known, 112); // 7 + 100 + 5
  assert.equal(total.passes, 3);
  assert.equal(byListing.length, 2);
  assert.equal(byListing[0].url, 'https://x/issues');
});

test('detectDateSpikes: o dia da captura bulk salta à vista; dias normais não', () => {
  const rows = [];
  for (let d = 1; d <= 20; d++) rows.push({ source_id: 6, d: `2026-08-${String(d).padStart(2, '0')}`, c: 10 + (d % 5) });
  rows.push({ source_id: 6, d: '2026-08-30', c: 4417 }); // a captura bulk medida
  const spikes = detectDateSpikes(rows);
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0].date, '2026-08-30');
  assert.equal(spikes[0].count, 4417);
});

test('detectDateSpikes: respeita o piso mínimo (picos legítimos de fonte pequena não assustam)', () => {
  const rows = [
    { source_id: 9, d: '2026-08-30', c: 20 },
    { source_id: 9, d: '2026-08-31', c: 18 },
    { source_id: 9, d: '2026-09-01', c: 19 },
  ];
  assert.equal(detectDateSpikes(rows).length, 0);
});

test('sourceFlags: fonte sem base_url/fora do sources.json/muda é sinalizada', () => {
  const row = {
    name: 'The Rundown', base_url: null, cursor_date: null, articles: 311,
    last_date: '2026-09-01', needs_enrich: 2, thin: 0,
  };
  const flags = sourceFlags(row, { now: new Date('2026-10-03T00:00:00Z') });
  assert.ok(flags.some((f) => f.includes('SEM base_url')));
  assert.ok(flags.some((f) => f.includes('FORA do sources.json')));
  assert.ok(flags.some((f) => f.includes('sem cursor')));
  assert.ok(flags.some((f) => f.includes('muda há 32 dias')));
  assert.ok(flags.some((f) => f.includes('2 item(ns) só-blurb')));
  // Com entrada no config e URL igual, os avisos de drift somem.
  const ok = sourceFlags({ ...row, base_url: 'https://www.therundown.ai/articles' }, {
    configEntry: { url: 'https://www.therundown.ai/articles' },
    now: new Date('2026-10-03T00:00:00Z'),
  });
  assert.ok(!ok.some((f) => f.includes('FORA do sources.json')));
  assert.ok(!ok.some((f) => f.includes('SEM base_url')));
});

test('dupAttribution (curadoria): URL conhecida vs colisão de hash com twin', () => {
  stmts.insertArticle.run({
    source_id: null, url: 'https://a/original', title: 'T', content: 'titulo — blurb',
    content_hash: sha256('titulo — blurb'),
    published_at: null, run_id: 1, kind: 'news', issue_url: null, section: null,
    blurb: 'blurb', content_source: 'aggregator', cleaned: 0, needs_enrich: 0,
  });
  assert.deepEqual(dupAttribution('https://a/original', 'titulo — blurb'), { by: 'url', twin: null });
  const hit = dupAttribution('https://a/OUTRA-url', 'titulo — blurb');
  assert.equal(hit.by, 'hash');
  assert.equal(hit.twin, 'https://a/original');
  // Conteúdo nunca visto: suprimido sem twin conhecido (mas continua sendo 'hash').
  assert.equal(dupAttribution('https://a/novo', 'outro conteudo').by, 'hash');
});

test('buildAuditReport + renderAudit: relatório íntegro sobre base semeada', () => {
  stmts.upsertSource.get({ name: 'Fonte X', base_url: 'https://fonte-x.test/issues', type: 'index', max_index_pages: null });
  // Evento de dup com a classificação nova (by/twin) — o audit separa skip × perda por ele.
  stmts.insertEvent.run({
    run_id: 999, source_id: null, url: 'https://a/OUTRA-url', stage: 'item', status: 'dup',
    detail: JSON.stringify({ issue: 'https://fonte-x.test/issues/1', by: 'hash', twin: 'https://a/original' }),
  });
  const rep = buildAuditReport({ now: new Date('2026-10-03T00:00:00Z') });
  assert.ok(rep.sources.some((s) => s.name === 'Fonte X'));
  assert.ok(rep.drift.notSeeded.includes('Fonte X')); // sem entrada no sources.json da sandbox
  assert.equal(rep.discovery.dup.byHash, 1);
  assert.equal(rep.discovery.dup.losses[0].twin, 'https://a/original');
  assert.ok(rep.errors && rep.queue && rep.anomalies);
  const lines = renderAudit(rep, { verbose: true });
  assert.ok(lines.some((l) => l.includes('audit (modo debug)')));
  assert.ok(lines.some((l) => l.includes('Fonte X')));
  assert.ok(lines.some((l) => l.includes('DESCOBERTA × SALVAMENTO')));
  assert.ok(lines.some((l) => l.includes('PERDIDOS')));
});
