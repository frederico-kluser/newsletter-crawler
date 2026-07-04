// Detecção de tipo da fonte: as funções PURAS (sinais + heurística) que embasam a decisão da IA e
// servem de fallback quando a IA não está disponível/falha. Sem rede/LLM. npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatherTypeSignals, heuristicType } from '../src/detect-type.js';

const issueLinks = (host, n, base = 430) =>
  Array.from({ length: n }, (_, i) => ({ url: `https://${host}/issues/${base - i}`, title: `Issue ${base - i}` }));

test('gatherTypeSignals: conta internos/externos e links que "parecem edição"', () => {
  const url = 'https://nodeweekly.com/issues';
  const links = [
    ...issueLinks('nodeweekly.com', 10),
    { url: 'https://nodeweekly.com/about', title: 'About' }, // interno, não-edição
    { url: 'https://example.com/article', title: 'externo' },
  ];
  const sig = gatherTypeSignals({ url, links, proseLen: 300 });
  assert.equal(sig.host, 'nodeweekly.com');
  assert.equal(sig.urlMatchesIndexPath, true);
  assert.equal(sig.internalLinks, 11);
  assert.equal(sig.externalLinks, 1);
  assert.equal(sig.issueLikeInternalLinks, 10);
  assert.equal(sig.proseChars, 300);
});

test('heuristicType: URL /issues + muitos links de edição -> index', () => {
  const sig = gatherTypeSignals({
    url: 'https://nodeweekly.com/issues',
    links: [...issueLinks('nodeweekly.com', 10), { url: 'https://ex.com/a', title: 'x' }],
    proseLen: 300,
  });
  assert.equal(heuristicType(sig), 'index');
});

test('heuristicType: página de links EXTERNOS (sem padrão de índice) -> listing', () => {
  const links = [
    ...Array.from({ length: 12 }, (_, i) => ({ url: `https://out${i}.com/post`, title: `p${i}` })),
    { url: 'https://links.example.com/about', title: 'About' },
    { url: 'https://links.example.com/rss', title: 'RSS' },
  ];
  const sig = gatherTypeSignals({ url: 'https://links.example.com/', links, proseLen: 200 });
  assert.equal(sig.externalLinks, 12);
  assert.equal(sig.issueLikeInternalLinks, 0);
  assert.equal(heuristicType(sig), 'listing');
});

test('heuristicType: index por VOLUME de edições internas mesmo sem padrão na URL', () => {
  const links = [
    ...Array.from({ length: 9 }, (_, i) => ({ url: `https://weekly.example.com/2026/${i + 1}`, title: `m${i}` })),
    { url: 'https://ex.com/a', title: 'externo' },
  ];
  const sig = gatherTypeSignals({ url: 'https://weekly.example.com/all', links, proseLen: 300 });
  assert.equal(sig.urlMatchesIndexPath, false);
  assert.equal(sig.issueLikeInternalLinks, 9);
  assert.equal(heuristicType(sig), 'index');
});

test('heuristicType: arquivo de blog (links próprios /p/slug, prosa) -> listing', () => {
  // Substack /archive: /archive casa o padrão de URL, mas os links são posts próprios (/p/slug),
  // que NÃO parecem edição -> não vira index.
  const links = Array.from({ length: 20 }, (_, i) => ({
    url: `https://blog.substack.com/p/post-${i}`, title: `Post ${i}`,
  }));
  const sig = gatherTypeSignals({ url: 'https://blog.substack.com/archive', links, proseLen: 800 });
  assert.equal(sig.urlMatchesIndexPath, true);
  assert.equal(sig.issueLikeInternalLinks, 0);
  assert.equal(heuristicType(sig), 'listing');
});
