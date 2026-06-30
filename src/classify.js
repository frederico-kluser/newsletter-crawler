// Pós-processamento: classificação multi-faceta dos artigos contra o vocabulário controlado.
// Fan-out PLANO: 1 agente por faceta, todos em paralelo por artigo, passando por um GATE
// GLOBAL (limita o total de chamadas simultâneas na OpenRouter). Cada artigo persiste numa
// transação (1 linha em `classifications` + índice em `article_tags` + `classification_uncovered`).
import pLimit from 'p-limit';
import { stmts, db } from './db.js';
import { getFacets, buildFacetPrompt, validateFacetTags, taxonomyVersion } from './taxonomy.js';
import { classifyFacet } from './llm.js';
import { CLASSIFY_MODEL, CLASSIFY_CONCURRENCY, ARTICLE_CONCURRENCY } from './config.js';
import { log, warn, errorLog } from './util.js';

// Classifica 1 artigo: dispara as 9 facetas pelo gate e monta o objeto de resultado.
// Fail-open por faceta: uma faceta que falhar vira tags=[] e marca o artigo como 'partial',
// para que um erro pontual não derrube o lote inteiro.
async function classifyOne(article, gate) {
  const facets = getFacets();
  const results = await Promise.all(
    facets.map((facet) =>
      gate(async () => {
        const { system, user } = buildFacetPrompt(facet, article);
        try {
          const raw = await classifyFacet({ system, user });
          const { tags, dropped } = validateFacetTags(facet.name, raw.tags);
          if (dropped.length) {
            warn(
              `classify[${facet.name}] descartou ${dropped.length} tag(s) fora do vocab: ` +
                dropped.slice(0, 8).join(', '),
            );
          }
          const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0));
          const uncovered = (raw.uncovered || [])
            .map((t) => String(t).trim())
            .filter(Boolean)
            .slice(0, 3);
          return { facet: facet.name, tags, uncovered, confidence, ok: true };
        } catch (e) {
          warn(`classify[${facet.name}] falhou (${article.url}): ${e.message}`);
          return { facet: facet.name, tags: [], uncovered: [], confidence: 0, ok: false };
        }
      }),
    ),
  );

  const facetsOut = {};
  const confidences = {};
  const uncoveredOut = [];
  let domainConfidence = null;
  let anyFail = false;
  for (const r of results) {
    facetsOut[r.facet] = r.tags;
    confidences[r.facet] = r.confidence;
    if (r.facet === 'domain') domainConfidence = r.confidence;
    for (const term of r.uncovered) uncoveredOut.push({ facet: r.facet, term });
    if (!r.ok) anyFail = true;
  }
  // Faceta obrigatória sem nenhuma tag => marca 'partial' (sinal de baixa qualidade).
  const missingMandatory = facets.some(
    (f) => f.mandatory && (facetsOut[f.name] || []).length === 0,
  );

  return {
    facets: facetsOut,
    confidences,
    uncovered: uncoveredOut,
    domain_confidence: domainConfidence,
    taxonomy_version: taxonomyVersion(),
    status: anyFail || missingMandatory ? 'partial' : 'done',
  };
}

// Persistência atômica de 1 artigo (better-sqlite3: transação síncrona).
const persist = db.transaction((article, result) => {
  stmts.upsertClassification.run({
    article_id: article.id,
    result_json: JSON.stringify(result),
    domain_confidence: result.domain_confidence ?? null,
    taxonomy_version: result.taxonomy_version ?? null,
    model_used: CLASSIFY_MODEL,
    status: result.status,
  });
  stmts.deleteTagsForArticle.run(article.id);
  for (const [facet, tags] of Object.entries(result.facets)) {
    tags.forEach((tag, rank) => stmts.insertTag.run({ article_id: article.id, facet, tag, rank }));
  }
  stmts.deleteUncoveredForArticle.run(article.id);
  for (const u of result.uncovered) {
    stmts.insertUncovered.run({ article_id: article.id, facet: u.facet ?? null, term: u.term });
  }
});

/**
 * Classifica os artigos pendentes (ou todos, com force). Idempotente e retomável: sem force
 * só pega quem ainda não tem classificação. Retorna { classified, total }.
 */
export async function classifyPending({ limit = Infinity, force = false } = {}) {
  const lim = Number.isFinite(limit) ? limit : -1; // SQLite: LIMIT -1 = sem limite
  const rows = force
    ? stmts.listArticlesForReclassify.all(lim)
    : stmts.listArticlesNeedingClassification.all(lim);
  if (!rows.length) {
    log('classify: nada a classificar.');
    return { classified: 0, total: 0 };
  }

  const facetCount = getFacets().length;
  log(
    `classify: ${rows.length} artigo(s) — model=${CLASSIFY_MODEL}, ` +
      `${facetCount} facetas/artigo, force=${force}.`,
  );

  const gate = pLimit(CLASSIFY_CONCURRENCY); // teto GLOBAL de chamadas de faceta
  const outer = pLimit(ARTICLE_CONCURRENCY); // janela de artigos simultâneos
  let done = 0;
  let partial = 0;

  await Promise.all(
    rows.map((article) =>
      outer(async () => {
        try {
          const result = await classifyOne(article, gate);
          persist(article, result);
          done++;
          if (result.status === 'partial') partial++;
          const label = (article.title || article.url || '').slice(0, 60);
          log(`classify ok [${done}/${rows.length}] ${label} (${result.status})`);
        } catch (e) {
          errorLog(`classify falhou (${article.url}): ${e.message}`);
        }
      }),
    ),
  );

  log(`classify concluído: ${done}/${rows.length} (partial=${partial}).`);
  return { classified: done, total: rows.length };
}
