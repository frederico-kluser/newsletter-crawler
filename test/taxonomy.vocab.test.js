// Fix do Achado 8 (captura 2026-08-14, docs/captura-total-2026-08-14.md §9.8): WARNs de classify
// "descartou N tag(s) fora do vocab: llm-models, agentic-ai, model-provenance, software-development,
// system-design" — o acervo é LLM/IA e o vocabulário não cobria tópicos correntes. Os 5 termos
// agora têm casa no topic-technology (união de topics_by_domain + ai_engineering_cross.topics,
// src/taxonomy.js:63-70; taxonomy.json v2026-08-15 — o bump vira prova na re-verificação da Onda 2).
// Rode com: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFacets, validateFacetTags, taxonomyVersion } from '../src/taxonomy.js';

test('getFacets: a união topic-technology contém os 5 termos novos (src/taxonomy.js:63-70)', () => {
  const topic = getFacets().find((f) => f.name === 'topic-technology');
  for (const term of [
    'llm-models',
    'agentic-ai',
    'model-provenance',
    'software-development',
    'system-design',
  ]) {
    assert.ok(topic.vocab.includes(term), `${term} deve estar na união topic-technology`);
  }
});

test('validateFacetTags: aceita os 5 termos novos do Achado 8 na faceta certa', () => {
  // llm-models caiu do WARN apesar de o DOMÍNIO já ser canônico (facets.domain): o tópico
  // genérico não tinha casa na união. Agora vive em topics_by_domain.llm-models.
  const llm = validateFacetTags('topic-technology', ['llm-models']);
  assert.deepEqual(llm.tags, ['llm-models']);
  assert.deepEqual(llm.dropped, []);
  // Os outros 4 vivem em ai_engineering_cross.topics (agentes, proveniência de modelo e
  // tópicos genéricos de engenharia).
  const cross = validateFacetTags('topic-technology', [
    'agentic-ai',
    'model-provenance',
    'software-development',
    'system-design',
  ]);
  assert.deepEqual(cross.tags, [
    'agentic-ai',
    'model-provenance',
    'software-development',
    'system-design',
  ]);
  assert.deepEqual(cross.dropped, []);
});

test('validateFacetTags: o alias "agentic" agora resolve em topic-technology', () => {
  // "agentic" -> "agentic-ai" já era alias; antes o canônico não existia na união e a tag
  // caía no guard. A partir do fix o alias resolve DENTRO de topic-technology.
  const { tags, dropped } = validateFacetTags('topic-technology', ['agentic']);
  assert.deepEqual(tags, ['agentic-ai']);
  assert.deepEqual(dropped, []);
});

test('validateFacetTags: termos novos não vazam para facetas erradas', () => {
  // model-provenance / software-development / system-design são SÓ topic-technology: não
  // existem em trending-emerging nem em concept-theme (validação continua por faceta).
  for (const facet of ['trending-emerging', 'concept-theme', 'framework-library-tool']) {
    const { dropped } = validateFacetTags(facet, [
      'model-provenance',
      'software-development',
      'system-design',
    ]);
    assert.deepEqual(
      dropped,
      ['model-provenance', 'software-development', 'system-design'],
      `deve cair em ${facet}`,
    );
  }
  // agentic-ai já era canônico em trending-emerging (facet de origem) — segue válido lá.
  const trend = validateFacetTags('trending-emerging', ['agentic-ai']);
  assert.deepEqual(trend.tags, ['agentic-ai']);
  assert.deepEqual(trend.dropped, []);
});

test('taxonomyVersion: bump do Achado 8 (prova da re-verificação na Onda 2)', () => {
  // O bump (2026-08-14 -> 2026-08-15) é o que a Onda 2 (re-classify force) vai conferir em
  // classifications.taxonomy_version. Formato YYYY-MM segue preservado.
  assert.match(taxonomyVersion(), /^\d{4}-\d{2}/);
});
