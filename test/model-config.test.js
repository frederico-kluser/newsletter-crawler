// Contrato de RESOLUÇÃO DE MODELOS pós-troca p/ deepseek/deepseek-v4-flash-0731 (commit 54c5c68):
// slug único em TODOS os estágios, efforts preservados (xhigh/high/medium), contrato do
// config/models.json, o gotcha STAGE_KEYS do articleReclean e o seed de orçamento do slug novo.
// Env limpo ANTES do import dinâmico: config.js lê process.env no LOAD (MODELS/STAGE_MODELS são
// pré-computados) e ainda sobrescreve com o .env do NC_HOME temporário (vazio) — o .env do usuário
// real NÃO pode vazar para cá (mesmo padrão de test/budget.test.js / test/config.key.test.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NC_HOME = mkdtempSync(path.join(tmpdir(), 'nc-model-config-'));
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LLM_') || k.startsWith('CLASSIFY_')) delete process.env[k]; // sem override de env
}

const { MODELS, STAGE_KEYS, stageModel, classifyFacetModel, STAGE_MODELS } = await import('../src/config.js');
const { BudgetLedger } = await import('../src/budget.js');
const { db } = await import('../src/db.js');
const { getFacets } = await import('../src/taxonomy.js');

after(() => {
  db.close();
  rmSync(process.env.NC_HOME, { recursive: true, force: true });
});

// Slug da troca (Onda 1): todas as etapas apontam para o MESMO modelo. Literal de propósito —
// é exatamente o que a troca fez e o que estes testes congelam.
const SWAPPED_SLUG = 'deepseek/deepseek-v4-flash-0731';

// Tabela LITERAL dos efforts esperados por estágio (xhigh/high/medium). NÃO ler do models.json
// no teste — a tabela fixa é o que pega regressão de effort (ex.: searchBatch voltando a high).
const EXPECTED_EFFORTS = {
  linkSelector: 'xhigh', // deriva o seletor CSS dos links da listagem
  linkExtract: 'xhigh', // fallback: extrai links item-a-item
  roundupExtract: 'xhigh', // fallback: extrai links externos curados de uma issue/roundup
  nextLink: 'xhigh', // deriva o link da próxima página (paginação)
  contentSelector: 'xhigh', // deriva o seletor CSS do corpo do artigo
  articleExtract: 'xhigh', // fallback: extrai título/corpo/data do artigo
  classify: 'high', // classificação multi-faceta de tags (etapa base; as 7 facetas têm medium)
  summarize: 'high', // resumo + título em PT-BR
  searchRelevance: 'high', // busca modo A: julga artigo vs consulta
  searchBatch: 'medium', // busca soft da web: julga um LOTE de ~40 artigos vs consulta
  searchTags: 'high', // busca modo B: mapeia consulta -> tags por faceta
  searchSpec: 'high', // busca precisão-primeiro: "entende" a consulta -> spec
  curate: 'high', // curadoria da issue: itens estruturados news/tool/release
  articleClean: 'medium', // limpeza pré-save do conteúdo extraído
  verifyRecord: 'high', // verificação pós-cadastro: veredito ok|suspect|junk
  dateSelector: 'high', // seletor de DATA da listagem (CSS + regex) lendo a página real
  detectType: 'high', // detecção automática do tipo da fonte (index|listing) ao adicionar
};

test('slug único em TODOS os estágios de STAGE_KEYS (env limpo)', () => {
  for (const stage of STAGE_KEYS) {
    assert.equal(stageModel(stage).model, SWAPPED_SLUG, `stageModel("${stage}").model`);
    assert.equal(STAGE_MODELS[stage].model, SWAPPED_SLUG, `STAGE_MODELS.${stage}.model`);
  }
  // STAGE_KEYS é a fonte da verdade da resolução; não pode encolher sem o teste da tabela gritar.
  assert.ok(STAGE_KEYS.length > 0);
});

test('efforts preservados por estágio (tabela literal xhigh/high/medium)', () => {
  assert.equal(STAGE_KEYS.length, Object.keys(EXPECTED_EFFORTS).length, 'tabela esperada cobre TODOS os estágios');
  assert.deepEqual(
    Object.fromEntries(STAGE_KEYS.map((s) => [s, stageModel(s).effort])),
    EXPECTED_EFFORTS,
  );
});

test('searchBatch = medium (think no MÍNIMO na busca soft)', () => {
  assert.equal(stageModel('searchBatch').effort, 'medium');
  assert.equal(EXPECTED_EFFORTS.searchBatch, 'medium');
});

test('MODELS.pro === MODELS.flash === slug novo (sem env override)', () => {
  assert.equal(MODELS.pro, SWAPPED_SLUG);
  assert.equal(MODELS.flash, SWAPPED_SLUG);
  assert.equal(MODELS.pro, MODELS.flash);
});

test('seedForModel: slug novo cai em SEED_FLASH (0.005); sem "flash" = SEED_PRO (0.05)', () => {
  const l = new BudgetLedger({ budgetUsd: 0 });
  assert.equal(l.seedFor(SWAPPED_SLUG), 0.005, `'${SWAPPED_SLUG}' contém 'flash' -> SEED_FLASH`);
  assert.equal(l.seedFor('acme/llm-probe'), 0.05, 'sem "flash" -> SEED_PRO');
  // Caminho real usado pelo ledger (mesma assertiva de test/budget.test.js, agora com o slug NOVO
  // explícito e sem dados de EMA): a reserva da chamada usa o seed do tier.
  assert.equal(l.estimate('summarize', SWAPPED_SLUG), 0.005, 'seed flash antes de dados EMA');
  assert.equal(l.estimate('classify', 'acme/llm-probe'), 0.05, 'seed pro antes de dados EMA');
});

test('contrato do config/models.json: JSON válido, default presente, chaves de stages válidas', () => {
  const modelsJsonPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'config',
    'models.json',
  );
  const cfg = JSON.parse(readFileSync(modelsJsonPath, 'utf8')); // JSON.parse lança se inválido
  assert.ok(cfg && typeof cfg === 'object', 'raiz é objeto');
  assert.ok(cfg.default, 'chave "default" obrigatória');
  assert.equal(typeof cfg.default.model, 'string');
  assert.ok(cfg.default.model.length > 0, 'model default não pode ser vazio');
  assert.ok(['xhigh', 'high', 'medium'].includes(cfg.default.effort), 'effort default ∈ {xhigh, high, medium}');

  // Contrato das chaves de "stages": todo estágio referenciado é REAL (STAGE_KEYS), ou uma
  // classificação por faceta "classify:<faceta>", ou o articleReclean (usado via cleanArticleContent
  // com stage param, fora de STAGE_KEYS).
  const facets = getFacets().map((f) => f.name);
  for (const [key, def] of Object.entries(cfg.stages || {})) {
    const knownStage = STAGE_KEYS.includes(key) || key === 'articleReclean';
    assert.ok(knownStage || key.startsWith('classify:'), `chave desconhecida no models.json: "${key}"`);
    if (key.startsWith('classify:')) {
      const facet = key.slice('classify:'.length);
      assert.ok(facets.includes(facet), `"${key}" referencia uma faceta que não existe em getFacets()`);
    }
    assert.equal(typeof def.model, 'string', `${key}.model é string`);
    assert.ok(def.model.length > 0, `${key}.model não pode ser vazio`);
    assert.ok(['xhigh', 'high', 'medium'].includes(def.effort), `${key}.effort ∈ {xhigh, high, medium}`);
  }
  // Cobertura 1:1 (NÃO-vacuosa): as chaves classify:* do arquivo são EXATAMENTE as facetas
  // não-core de getFacets() — nem a mais (typo de faceta) nem a menos (faceta sem override
  // declarado), e as CORE (domain, topic-technology) NÃO podem ter chave própria: herdam a
  // etapa base classify. Se o perfil de custo mudar (ex.: uma core ganhar chave própria),
  // este assert quebra DE PROPÓSITO.
  const overriddenFacets = Object.keys(cfg.stages || {})
    .filter((k) => k.startsWith('classify:'))
    .map((k) => k.slice('classify:'.length))
    .sort();
  const coreFacets = ['domain', 'topic-technology'];
  assert.deepEqual(
    overriddenFacets,
    facets.filter((f) => !coreFacets.includes(f)).sort(),
    'chaves classify:* do models.json = todas as facetas não-core (1:1 com getFacets)',
  );
  for (const f of coreFacets) {
    assert.equal(
      keyExists(cfg, `classify:${f}`),
      false,
      `faceta core "${f}" não pode ter chave própria (herda a etapa base classify)`,
    );
  }
});

function keyExists(cfg, key) {
  return Boolean(cfg.stages && Object.prototype.hasOwnProperty.call(cfg.stages, key));
}

test('classify:<faceta>: 7 facetas com override no models.json = slug novo + medium; core herda classify (high)', () => {
  const facets = new Set(getFacets().map((f) => f.name));
  // Facetas NÃO-core com chave própria no models.json (diff da troca: 7 linhas de override).
  // Literal de propósito — congela o perfil de custo barato (medium = vocabulário fixo).
  const overridden = [
    'difficulty',
    'content-type',
    'trending-emerging',
    'ecosystem-language',
    'company-vendor-model',
    'framework-library-tool',
    'concept-theme',
  ];
  for (const f of overridden) {
    assert.ok(facets.has(f), `${f} precisa ser uma faceta real`);
    assert.deepEqual(classifyFacetModel(f), { model: SWAPPED_SLUG, effort: 'medium' }, `faceta ${f}`);
  }
  // Core: sem chave própria -> herda a etapa base classify (slug novo + high).
  for (const f of ['domain', 'topic-technology']) {
    assert.ok(facets.has(f), `${f} precisa ser uma faceta real`);
    assert.deepEqual(classifyFacetModel(f), { model: SWAPPED_SLUG, effort: 'high' }, `faceta core ${f}`);
  }
  // Faceta desconhecida também herda a base (fail-open, nunca devolve null).
  assert.deepEqual(classifyFacetModel('nao-existe'), { model: SWAPPED_SLUG, effort: 'high' });
});

test('articleReclean NÃO está em STAGE_KEYS -> cai no DEFAULT (slug novo + xhigh), ignorando o high do models.json', () => {
  // GOTCHA conhecido (skill calling-the-llm-layer): a chave articleReclean existe no models.json
  // com effort high, mas o estágio NÃO está em STAGE_KEYS — stageModel resolve pelo default
  // (Pro/xhigh). Verificado em runtime 2026-08-13: STAGE_KEYS.includes('articleReclean') === false.
  // Este teste CONGELA o comportamento REAL: se articleReclean entrar em STAGE_KEYS, a resolução
  // passa a vir do arquivo (high) e estes asserts precisam mudar DE PROPÓSITO.
  assert.equal(STAGE_KEYS.includes('articleReclean'), false);
  assert.deepEqual(stageModel('articleReclean'), { model: SWAPPED_SLUG, effort: 'xhigh' });
  // Mesmo fallthrough do default para qualquer estágio desconhecido.
  assert.deepEqual(stageModel('stageInexistente'), { model: SWAPPED_SLUG, effort: 'xhigh' });
});
