// Pós-processamento: classificação multi-faceta dos artigos contra o vocabulário controlado.
// Fan-out PLANO: 1 agente por faceta, todos em paralelo por artigo, passando por um GATE
// GLOBAL (limita o total de chamadas simultâneas na OpenRouter). Cada artigo persiste numa
// transação (1 linha em `classifications` + índice em `article_tags` + `classification_uncovered`).
import pLimit from 'p-limit';
import { stmts, db } from './db.js';
import { getFacets, buildFacetPrompt, validateFacetTags, taxonomyVersion } from './taxonomy.js';
import { classifyFacet } from './llm.js';
import { CLASSIFY_MODEL, CLASSIFY_CONCURRENCY, ARTICLE_CONCURRENCY } from './config.js';
import { stageWindow } from './governor.js';
import { shouldStop } from './budget.js';
import { log, warn, errorLog } from './util.js';

// Erro-sentinela: a classificação NÃO rodou de fato — uma faceta OBRIGATÓRIA caiu por rede/API
// (ok:false, já depois dos retries do transporte em llm.js). Mesmo CONTRATO do BUDGET_EXCEEDED: o
// chamador NÃO persiste; o artigo fica sem linha em `classifications` e re-entra no próximo run.
// É o que evita o falso-positivo "classificado sem tags" quando a internet cai no meio (o bug do
// `finish`): antes, o catch por faceta engolia o erro e o artigo era gravado como 'partial' zerado,
// que `listArticlesNeedingClassification` (WHERE c.article_id IS NULL) nunca mais re-selecionava.
export class ClassifyIncompleteError extends Error {
  constructor(missing) {
    super(`classificação incompleta: faceta(s) obrigatória(s) falharam por rede/API: ${missing.join(', ')}`);
    this.name = 'ClassifyIncompleteError';
    this.code = 'CLASSIFY_INCOMPLETE';
    this.missing = missing;
  }
}

// Puro/testável: dado o resultado por faceta e as facetas, devolve os nomes das facetas
// OBRIGATÓRIAS que ERRARAM (ok:false). Vazio ⇒ o núcleo respondeu ⇒ pode persistir (mesmo que
// 'partial' por faceta vazia). O ponto é distinguir "errou" (ok:false: rede/API) de "vazia DE
// VERDADE" (ok:true, tags:[]: resposta real de baixa qualidade) — só o erro real mantém pendente,
// senão um artigo genuinamente sem tags re-classificaria para sempre.
export function failedMandatoryFacets(results, facets) {
  const mandatory = new Set(facets.filter((f) => f.mandatory).map((f) => f.name));
  return results.filter((r) => r.ok === false && mandatory.has(r.facet)).map((r) => r.facet);
}

// Classifica 1 artigo: dispara as 9 facetas pelo gate e monta o objeto de resultado.
// Fail-open por faceta NÃO-obrigatória: uma que falhar vira tags=[] e marca o artigo como
// 'partial', para que um erro pontual não derrube o lote. MAS se uma faceta OBRIGATÓRIA cair
// por rede/API, lança ClassifyIncompleteError (o chamador não persiste) — sem isso o artigo
// virava 'classificado' sem tags e nunca mais era re-selecionado (bug do finish com a net fora).
async function classifyOne(article, gate) {
  const facets = getFacets();
  const results = await Promise.all(
    facets.map((facet) =>
      gate(async () => {
        const { system, user } = buildFacetPrompt(facet, article);
        try {
          const raw = await classifyFacet({ facet: facet.name, system, user });
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
          // Orçamento: rethrow p/ NÃO persistir classificação parcial — o artigo segue
          // elegível (sem linha em classifications) e é retomado no próximo run.
          if (e?.code === 'BUDGET_EXCEEDED') throw e;
          warn(`classify[${facet.name}] falhou (${article.url}): ${e.message}`);
          return { facet: facet.name, tags: [], uncovered: [], confidence: 0, ok: false };
        }
      }),
    ),
  );

  // Rede/API caiu numa faceta OBRIGATÓRIA ⇒ classificação não confiável: aborta ANTES de montar/
  // persistir para o artigo não virar uma ficha 'classificada' sem tags. Fica sem linha em
  // classifications e re-tenta no próximo run (fail-safe, igual ao BUDGET_EXCEEDED).
  const failedMandatory = failedMandatoryFacets(results, facets);
  if (failedMandatory.length) throw new ClassifyIncompleteError(failedMandatory);

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
 * Classifica UMA ficha (fan-out por faceta na folga da lane llm) e persiste atomicamente.
 * Compartilhado pelo sweep (classifyPending) e pelo streaming pós-save (commands.js). classifyOne
 * re-lança BUDGET_EXCEEDED e ClassifyIncompleteError (faceta obrigatória caiu por rede/API) ANTES
 * de persistir, então um estouro/queda no meio NÃO deixa uma ficha classificada sem tags — o
 * chamador (que já dá catch) apenas não persiste e o artigo re-tenta no próximo run.
 */
export async function classifyArticleRow(article) {
  const result = await classifyOne(article, (fn) => fn());
  persist(article, result);
  return result;
}

/**
 * Classifica os artigos pendentes (ou todos, com force). Idempotente e retomável: sem force
 * só pega quem ainda não tem classificação. Retorna { classified, total, kept } — `kept` = artigos
 * mantidos pendentes porque uma faceta obrigatória caiu por rede/API (nada persistido; re-tenta).
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

  // O gate global de facetas morreu: a lane llm (no transporte do callJSON) já limita o total
  // simultâneo na OpenRouter. CLASSIFY_CONCURRENCY > 0 segue como teto fino opcional.
  const gate = CLASSIFY_CONCURRENCY > 0 ? pLimit(CLASSIFY_CONCURRENCY) : (fn) => fn();
  // Janela de artigos: min(override, capacidade atual da lane llm) — evita abrir milhares de
  // artigos "em voo" cujo trabalho real fica todo enfileirado na lane.
  const outer = pLimit(stageWindow(ARTICLE_CONCURRENCY));
  let done = 0;
  let partial = 0;
  let skipped = 0;
  let kept = 0; // facetas obrigatórias caíram por rede/API: nada persistido, segue pendente

  await Promise.all(
    rows.map((article) =>
      outer(async () => {
        if (shouldStop()) {
          skipped++;
          return; // orçamento: não INICIA artigo novo; os pulados retomam no próximo run
        }
        try {
          const result = await classifyOne(article, gate);
          persist(article, result);
          done++;
          if (result.status === 'partial') partial++;
          const label = (article.title || article.url || '').slice(0, 60);
          log(`classify ok [${done}/${rows.length}] ${label} (${result.status})`);
        } catch (e) {
          if (e?.code === 'BUDGET_EXCEEDED') {
            skipped++; // nada persistido: o artigo continua elegível
            return;
          }
          if (e?.code === 'CLASSIFY_INCOMPLETE') {
            kept++; // rede/API caiu numa faceta obrigatória: fica pendente, re-tenta com net
            return;
          }
          errorLog(`classify falhou (${article.url}): ${e.message}`);
        }
      }),
    ),
  );

  log(
    `classify concluído: ${done}/${rows.length} (partial=${partial}` +
      `${kept ? `, ${kept} mantidos pendentes por falha de rede/API — re-tente com internet` : ''}` +
      `${skipped ? `, ${skipped} pulados por orçamento — retome com \`ncrawl classify\`` : ''}).`,
  );
  return { classified: done, total: rows.length, kept };
}
