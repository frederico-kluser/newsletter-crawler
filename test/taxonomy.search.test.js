// Eval dos helpers de busca por tags (puros, sem LLM/DB): o prompt por faceta usa o vocabulário
// controlado, o bucketing news/tool e a validação contra o vocabulário. Rode com: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFacets, buildFacetQueryPrompt, isToolByTags, validateFacetTags, taxonomyVersion } from '../src/taxonomy.js';

test('buildFacetQueryPrompt: inclui a CONSULTA e o vocabulário da faceta', () => {
  const facet = getFacets().find((f) => f.name === 'framework-library-tool');
  const { system, user } = buildFacetQueryPrompt(facet, 'next.js server components');
  assert.match(user, /CONSULTA: next\.js server components/);
  assert.ok(user.includes('nextjs'), 'o vocabulário da faceta deve aparecer no prompt');
  assert.match(system, /faceta "framework-library-tool"/);
});

test('isToolByTags: framework-library-tool ou content-type de ferramenta -> true', () => {
  assert.equal(isToolByTags([{ facet: 'framework-library-tool', tag: 'nextjs', rank: 0 }]), true);
  assert.equal(isToolByTags([{ facet: 'content-type', tag: 'tool-release', rank: 0 }]), true);
  assert.equal(
    isToolByTags([
      { facet: 'content-type', tag: 'news', rank: 0 },
      { facet: 'domain', tag: 'reactjs', rank: 0 },
    ]),
    false,
  );
  assert.equal(isToolByTags([]), false);
});

test('validateFacetTags: mantém tags do vocabulário e corta as inventadas', () => {
  const { tags, dropped } = validateFacetTags('framework-library-tool', ['nextjs', 'tag-inexistente-xyz']);
  assert.ok(tags.includes('nextjs'));
  assert.ok(!tags.includes('tag-inexistente-xyz'));
  assert.ok(dropped.includes('tag-inexistente-xyz'));
});

// P3 (captura 2026-08-14, Node Weekly issue 637): 16 tags legítimas do ecossistema Node foram
// descartadas porque o vocabulário não as tinha NA faceta onde o modelo as sugeriu. As que
// faziam sentido ganharam casa (taxonomy.json v2026-08-14); as demais são facet-mismatch
// aceitas por design — os canônicos já existem em outra faceta e o modelo deve usá-los lá.
test('validateFacetTags: aceita os termos do ecossistema Node adicionados (P3)', () => {
  // nodejs caiu 5x em ecosystem-language: a runtime do JS é tratada como linguagem pelo modelo.
  const lang = validateFacetTags('ecosystem-language', ['nodejs']);
  assert.deepEqual(lang.tags, ['nodejs']);
  assert.deepEqual(lang.dropped, []);
  // O alias "node" passa a resolver DENTRO de ecosystem-language (o canônico agora existe lá).
  const langAlias = validateFacetTags('ecosystem-language', ['node']);
  assert.deepEqual(langAlias.tags, ['nodejs']);
  // static-analysis e sast caíram 1x cada; agora vivem em concept-theme (junto de security/testing).
  const theme = validateFacetTags('concept-theme', ['static-analysis', 'sast']);
  assert.deepEqual(theme.tags, ['static-analysis', 'sast']);
  // dom (artigo TermDOM) caiu 1x; agora vive em topic-technology via topics_by_domain.frontend.
  const dom = validateFacetTags('topic-technology', ['dom']);
  assert.deepEqual(dom.tags, ['dom']);
  // activitypub (release NodeBB 4.15.0) caiu 1x; agora vive em topic-technology via topics_by_domain.backend.
  const ap = validateFacetTags('topic-technology', ['activitypub']);
  assert.deepEqual(ap.tags, ['activitypub']);
});

test('validateFacetTags: sem regressão — canônicos pré-existentes da captura seguem válidos', () => {
  // nodejs já existia em domain / topic-technology / framework-library-tool — continua.
  for (const facet of ['domain', 'topic-technology', 'framework-library-tool']) {
    const { tags, dropped } = validateFacetTags(facet, ['nodejs']);
    assert.ok(tags.includes('nodejs'), `nodejs deve valer em ${facet}`);
    assert.deepEqual(dropped, []);
  }
  // Quedas aceitas por design (facet-mismatch): os canônicos seguem nas facetas de origem —
  // javascript/typescript em ecosystem-language E topic-technology, postgresql/docker em
  // framework-library-tool (tools_by_domain.backend), ai-agents em trending-emerging.
  const lang = validateFacetTags('ecosystem-language', ['typescript', 'javascript']);
  assert.deepEqual(lang.tags, ['typescript', 'javascript']);
  const topic = validateFacetTags('topic-technology', ['typescript', 'javascript']);
  assert.deepEqual(topic.tags, ['typescript', 'javascript']);
  const tools = validateFacetTags('framework-library-tool', ['postgresql', 'docker']);
  assert.deepEqual(tools.tags, ['postgresql', 'docker']);
  const trend = validateFacetTags('trending-emerging', ['ai-agents']);
  assert.deepEqual(trend.tags, ['ai-agents']);
  // Os termos NOVOS não vazam para facetas erradas (validação continua por faceta).
  assert.ok(validateFacetTags('ecosystem-language', ['dom']).dropped.includes('dom'));
  assert.ok(validateFacetTags('framework-library-tool', ['dom']).dropped.includes('dom'));
  assert.ok(validateFacetTags('trending-emerging', ['static-analysis']).dropped.includes('static-analysis'));
});

test('taxonomyVersion: segue o formato YYYY-MM (prova do bump no taxonomy.json)', () => {
  assert.match(taxonomyVersion(), /^\d{4}-\d{2}/);
});
