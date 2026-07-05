// Testes da lib PURA de filtros do webapp — espelham a semântica do WEB_WHERE do CLI
// (test/web.api.test.js): facetas AND-de-OR, kind de 3 vias (release exato; coluna vence
// tags; NULL cai no fallback por tags), período sobre date_iso e verify. Sem React/DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters, computeFacetCounts, countActiveFilters, sortForDisplay, EMPTY_FILTERS } from '../src/lib/filters.js';
import { effectiveKind, isToolByTags } from '../src/lib/taxonomy.js';

const TOOL_TYPES = ['tool-release', 'tooling', 'library-release', 'product-launch'];

let nextId = 1;
const art = (over = {}) => ({
  id: nextId++,
  source_id: 1,
  url: `http://t/${nextId}`,
  title: 't',
  title_pt: null,
  summary_pt: null,
  snippet: '',
  date_iso: '2026-06-15',
  kind: null,
  section: null,
  verify_status: null,
  verify_notes: null,
  tags: {},
  ...over,
});

const f = (over = {}) => ({ ...EMPTY_FILTERS, facets: {}, ...over });
const ids = (list) => list.map((a) => a.id);

test('facetas: INTERSEÇÃO (AND) dentro da faceta E entre facetas', () => {
  const rsc = art({ tags: { domain: ['reactjs'], 'content-type': ['deep-dive'] } });
  const llm = art({ tags: { domain: ['local-llm'] } });
  const both = art({ tags: { domain: ['reactjs', 'local-llm'] } });
  const semTags = art();
  const all = [rsc, llm, both, semTags];

  // uma tag: todos que a possuem (rsc e both têm reactjs)
  assert.deepEqual(ids(applyFilters(all, f({ facets: { domain: ['reactjs'] } }), TOOL_TYPES)), [rsc.id, both.id]);
  // DUAS tags na MESMA faceta = AND: só quem tem AS DUAS (antes, com OR, retornava 3)
  assert.deepEqual(ids(applyFilters(all, f({ facets: { domain: ['reactjs', 'local-llm'] } }), TOOL_TYPES)), [both.id]);
  // AND entre facetas continua igual
  assert.deepEqual(
    ids(applyFilters(all, f({ facets: { domain: ['reactjs'], 'content-type': ['deep-dive'] } }), TOOL_TYPES)),
    [rsc.id],
  );
  assert.equal(
    applyFilters(all, f({ facets: { domain: ['reactjs'], 'content-type': ['tutorial'] } }), TOOL_TYPES).length,
    0,
  );
  // artigo sem tags nunca passa num filtro de faceta (mesma semântica do NOT EXISTS do SQL)
  assert.ok(!ids(applyFilters(all, f({ facets: { domain: ['reactjs'] } }), TOOL_TYPES)).includes(semTags.id));
});

test('computeFacetCounts: co-ocorrência sobre o conjunto filtrado (selecionada=|R|, ausente=0)', () => {
  const a1 = art({ tags: { domain: ['reactjs', 'nodejs'], 'content-type': ['deep-dive'] } });
  const a2 = art({ tags: { domain: ['reactjs'], 'content-type': ['tutorial'] } });
  const a3 = art({ tags: { domain: ['local-llm'] } });
  // R = itens filtrados por domain=reactjs (interseção) → [a1, a2]
  const R = applyFilters([a1, a2, a3], f({ facets: { domain: ['reactjs'] } }), TOOL_TYPES);
  const counts = computeFacetCounts(R);
  assert.equal(counts.domain.reactjs, 2); // tag selecionada: todo item de R a tem → |R|
  assert.equal(counts.domain.nodejs, 1); // co-ocorre só em a1
  assert.equal(counts['content-type']['deep-dive'], 1);
  assert.equal(counts['content-type'].tutorial, 1);
  assert.equal(counts.domain['local-llm'], undefined); // fora de R → ausente (a UI trata como 0/desabilita)
  assert.deepEqual(computeFacetCounts([]), {}); // conjunto vazio → sem contagens
});

test('kind: release é match exato da coluna; segue contando como tool no bucket amplo', () => {
  const release = art({ kind: 'release' });
  const news = art({ kind: 'news' });
  const all = [release, news];
  assert.deepEqual(ids(applyFilters(all, f({ kind: 'release' }), TOOL_TYPES)), [release.id]);
  assert.ok(ids(applyFilters(all, f({ kind: 'tool' }), TOOL_TYPES)).includes(release.id));
  assert.deepEqual(ids(applyFilters(all, f({ kind: 'news' }), TOOL_TYPES)), [news.id]);
});

test('kind: a coluna curada VENCE as tags; NULL cai no fallback por tags', () => {
  const newsComTagTool = art({ kind: 'news', tags: { 'framework-library-tool': ['vitest'] } });
  const nullComTagTool = art({ kind: null, tags: { 'framework-library-tool': ['vitest'] } });
  const nullComContentType = art({ kind: null, tags: { 'content-type': ['tool-release'] } });
  const nullSemNada = art();
  const all = [newsComTagTool, nullComTagTool, nullComContentType, nullSemNada];

  const tools = ids(applyFilters(all, f({ kind: 'tool' }), TOOL_TYPES));
  assert.ok(!tools.includes(newsComTagTool.id), 'news por coluna fica fora mesmo com tag de ferramenta');
  assert.ok(tools.includes(nullComTagTool.id), 'NULL + tag de framework entra como tool');
  assert.ok(tools.includes(nullComContentType.id), 'NULL + content-type de ferramenta entra como tool');
  const news = ids(applyFilters(all, f({ kind: 'news' }), TOOL_TYPES));
  assert.ok(news.includes(newsComTagTool.id) && news.includes(nullSemNada.id));
});

test('effectiveKind/isToolByTags: badge do card segue a coluna com fallback', () => {
  assert.equal(effectiveKind(art({ kind: 'release' }), TOOL_TYPES), 'release');
  assert.equal(effectiveKind(art({ tags: { 'framework-library-tool': ['bun'] } }), TOOL_TYPES), 'tool');
  assert.equal(effectiveKind(art(), TOOL_TYPES), 'news');
  assert.equal(isToolByTags({ 'content-type': ['tooling'] }, TOOL_TYPES), true);
  assert.equal(isToolByTags({ 'content-type': ['deep-dive'] }, TOOL_TYPES), false);
  assert.equal(isToolByTags(null, TOOL_TYPES), false);
});

test('período sobre date_iso (inclusive) e fonte', () => {
  const junho01 = art({ date_iso: '2026-06-01' });
  const junho22 = art({ date_iso: '2026-06-22', source_id: 2 });
  const junho25 = art({ date_iso: '2026-06-25' });
  const all = [junho01, junho22, junho25];

  assert.deepEqual(ids(applyFilters(all, f({ from: '2026-06-21' }), TOOL_TYPES)), [junho22.id, junho25.id]);
  assert.deepEqual(ids(applyFilters(all, f({ to: '2026-06-05' }), TOOL_TYPES)), [junho01.id]);
  assert.deepEqual(ids(applyFilters(all, f({ from: '2026-06-22', to: '2026-06-22' }), TOOL_TYPES)), [junho22.id]);
  assert.deepEqual(ids(applyFilters(all, f({ sourceId: 2 }), TOOL_TYPES)), [junho22.id]);
});

test('verify filtra pelo selo exato', () => {
  const ok = art({ verify_status: 'ok' });
  const sus = art({ verify_status: 'suspect' });
  const semSelo = art();
  const all = [ok, sus, semSelo];
  assert.deepEqual(ids(applyFilters(all, f({ verify: 'suspect' }), TOOL_TYPES)), [sus.id]);
  assert.deepEqual(ids(applyFilters(all, f({ verify: 'ok' }), TOOL_TYPES)), [ok.id]);
});

test('sortForDisplay: data DESC com desempate por id DESC (não muta a entrada)', () => {
  const a = art({ date_iso: '2026-06-20' });
  const b = art({ date_iso: '2026-06-25' });
  const c = art({ date_iso: '2026-06-25' });
  const input = [a, b, c];
  const sorted = sortForDisplay(input);
  assert.deepEqual(ids(sorted), [c.id, b.id, a.id]);
  assert.deepEqual(ids(input), [a.id, b.id, c.id], 'entrada intacta');
});

test('countActiveFilters conta fonte/período/verify/tags (kind fica no Segmented)', () => {
  assert.equal(countActiveFilters(f()), 0);
  assert.equal(
    countActiveFilters(f({ sourceId: 1, from: '2026-06-01', verify: 'ok', facets: { domain: ['a', 'b'] }, kind: 'tool' })),
    5,
  );
});
