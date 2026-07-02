// Busca na base salva, em 2 modos:
//  A) exaustivo: 50 chamadas Flash (esforço alto) julgando CADA artigo vs a consulta (direto/parecido).
//  B) por tags: 5 chamadas Pro (1 por faceta de retrieval) -> une as tags -> retrieval por article_tags.
// Resultado é EFÊMERO (não persiste): { query, mode, scanned, total, relevant, buckets:{noticias,ferramentas} }.
// Cada item também é renderizado via log() (paridade CLI) e devolvido como objeto (a UI mostra rico).
import pLimit from 'p-limit';
import { stmts } from './db.js';
import { judgeRelevance, mapQueryToFacetTags } from './llm.js';
import {
  getFacets, RETRIEVAL_FACETS, buildFacetQueryPrompt, validateFacetTags, isToolByTags,
} from './taxonomy.js';
import { SEARCH_FLASH_CONCURRENCY } from './config.js';
import { stageWindow } from './governor.js';
import { shouldStop } from './budget.js';
import { log, warn } from './util.js';

// Progresso global (a busca é efêmera, então getStatus() não se move) — a UI faz poll disto.
let _progress = { scanned: 0, total: 0, relevant: 0 };
export function getSearchProgress() {
  return _progress;
}
const resetProgress = (total) => {
  _progress = { scanned: 0, total, relevant: 0 };
};

const snippet = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
const toItem = (a) => ({
  id: a.id,
  url: a.url,
  title: a.title,
  title_pt: a.title_pt,
  summary_pt: a.summary_pt,
  snippet: snippet(a.content),
});

function bucketize(hits, isTool) {
  const noticias = [];
  const ferramentas = [];
  for (const h of hits) (isTool(h) ? ferramentas : noticias).push(h);
  return { noticias, ferramentas };
}

const RANK = { direct: 0, similar: 1 };

async function runModeA(query, limit, { all = false, runId = null } = {}) {
  const lim = Number.isFinite(limit) ? limit : -1;
  const rows = all || runId == null
    ? stmts.listAllArticlesForSearch.all(lim)
    : stmts.listRunArticlesForSearch.all(runId, lim);
  resetProgress(rows.length);
  // Janela = min(override de env, capacidade atual da lane llm do governador).
  const gate = pLimit(stageWindow(SEARCH_FLASH_CONCURRENCY));
  const hits = [];
  let budgetSkipped = 0;
  await Promise.all(
    rows.map((a) =>
      gate(async () => {
        if (shouldStop()) {
          budgetSkipped++; // orçamento NÃO pode virar "none" silencioso: conta como não-avaliado
          return;
        }
        let rel = { relation: 'none', kind: 'news' };
        try {
          rel = await judgeRelevance({ query, title: a.title, content: a.content });
        } catch (e) {
          if (e?.code === 'BUDGET_EXCEEDED') {
            budgetSkipped++;
            return;
          }
          warn(`busca[A] ${a.url}: ${e.message}`); // fail-open -> none
        }
        _progress.scanned++;
        if (rel.relation === 'none') return;
        _progress.relevant++;
        if (_progress.scanned % 25 === 0) {
          log(`busca A: ${_progress.scanned}/${rows.length} avaliados · ${_progress.relevant} relevantes`);
        }
        hits.push({ ...toItem(a), relation: rel.relation, score: rel.relation, kind: rel.kind });
      }),
    ),
  );
  hits.sort((x, y) => RANK[x.relation] - RANK[y.relation]); // direct antes de similar (estável)
  const buckets = bucketize(hits, (h) => h.kind === 'tool');
  if (budgetSkipped) {
    warn(`busca A: orçamento atingido — avaliados ${_progress.scanned}/${rows.length} (${budgetSkipped} pulados)`);
  }
  return {
    query, mode: 'A', scanned: _progress.scanned, total: rows.length, relevant: hits.length,
    skipped: budgetSkipped, buckets,
  };
}

async function runModeB(query, limit, { all = false, runId = null } = {}) {
  if (stmts.countClassifications.get().c === 0) {
    warn('busca[B]: nenhuma classificação — rode "classify" ou use o Modo A.');
    return {
      query, mode: 'B', scanned: 0, total: 0, relevant: 0,
      needsClassification: true, buckets: { noticias: [], ferramentas: [] },
    };
  }
  const facets = getFacets().filter((f) => RETRIEVAL_FACETS.includes(f.name)); // exatamente 5
  const derived = new Set();
  const gate = pLimit(5); // exatamente 5 facetas -> 5 Pro em paralelo
  await Promise.all(
    facets.map((facet) =>
      gate(async () => {
        if (shouldStop()) return; // orçamento: faceta não derivada (a união das demais segue)
        try {
          const { system, user } = buildFacetQueryPrompt(facet, query);
          const raw = await mapQueryToFacetTags({ system, user });
          const { tags } = validateFacetTags(facet.name, raw); // restringe ao vocab + alias
          tags.forEach((t) => derived.add(t));
          log(`busca B [${facet.name}]: ${tags.join(', ') || '—'}`);
        } catch (e) {
          warn(`busca[B][${facet.name}]: ${e.message}`);
        }
      }),
    ),
  );
  if (!derived.size) {
    log('busca B: nenhuma tag derivada da consulta.');
    return { query, mode: 'B', scanned: 0, total: 0, relevant: 0, buckets: { noticias: [], ferramentas: [] } };
  }
  const lim = Number.isFinite(limit) ? limit : -1;
  const rows = all || runId == null
    ? stmts.articlesByTags.all({ tags: JSON.stringify([...derived]), limit: lim })
    : stmts.articlesByTagsForRun.all({ tags: JSON.stringify([...derived]), runId, limit: lim });
  const hits = rows.map((a) => ({ ...toItem(a), relation: `${a.matches} tags`, score: a.matches }));
  const buckets = bucketize(hits, (h) => isToolByTags(stmts.getTagsForArticle.all(h.id)));
  return {
    query, mode: 'B', scanned: rows.length, total: rows.length, relevant: rows.length,
    derivedTags: [...derived], buckets,
  };
}

// Render textual (CLI) — na UI esses logs aparecem no painel, e a ResultsView mostra o objeto.
function renderResults(r) {
  const sec = (nome, items) => {
    log(`\n— ${nome} (${items.length}) —`);
    for (const it of items.slice(0, 30)) {
      log(`• [${it.relation}] ${(it.title_pt || it.title || '').slice(0, 80)}`);
      const resumo = it.summary_pt || it.snippet;
      if (resumo) log(`    ${resumo.slice(0, 200)}`);
      log(`    ${it.url}`);
    }
  };
  log(`busca "${r.query}" (modo ${r.mode}): ${r.relevant} relevante(s) de ${r.total} avaliado(s).`);
  sec('NOTÍCIAS', r.buckets.noticias);
  sec('FERRAMENTAS', r.buckets.ferramentas);
}

export async function runSearch(
  query,
  { mode = 'A', limit = Infinity, yes = false, all = false, runId = null } = {},
) {
  void yes; // o guard de custo é aplicado no comando (cmdSearch)
  const scope = { all, runId };
  const r = mode === 'B' ? await runModeB(query, limit, scope) : await runModeA(query, limit, scope);
  renderResults(r);
  return r;
}
