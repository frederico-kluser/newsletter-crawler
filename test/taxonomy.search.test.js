// Eval dos helpers de busca por tags (puros, sem LLM/DB): o prompt por faceta usa o vocabulário
// controlado, o bucketing news/tool e a validação contra o vocabulário. Rode com: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFacets, buildFacetQueryPrompt, isToolByTags, validateFacetTags } from '../src/taxonomy.js';

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
