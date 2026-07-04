// Busca na base salva, em 2 modos:
//  A) exaustivo: 50 chamadas Flash (esforço alto) julgando CADA artigo vs a consulta (direto/parecido).
//  B) por tags: 5 chamadas Pro (1 por faceta de retrieval) -> une as tags -> retrieval por article_tags.
// Retorno: { query, mode, scanned, total, relevant, buckets:{noticias,ferramentas} }. Toda busca
// CONCLUÍDA é gravada na tabela `searches` (histórico congelado: ids+vereditos; persistSearch,
// fail-open) — restaurar do histórico re-hidrata do acervo SEM re-pagar LLM.
// Cada item também é renderizado via log() (paridade CLI) e devolvido como objeto (a UI mostra rico).
// A web UI tem motor próprio no fim do arquivo (searchWeb: soft em LOTE / hard por artigo).
import pLimit from 'p-limit';
import { stmts } from './db.js';
import { judgeRelevance, judgeRelevanceBatch, mapQueryToFacetTags, compileQuerySpec } from './llm.js';
import {
  getFacets, RETRIEVAL_FACETS, buildFacetQueryPrompt, validateFacetTags, isToolByTags,
} from './taxonomy.js';
import {
  SEARCH_FLASH_CONCURRENCY, SEARCH_BATCH_SIZE, SEARCH_BATCH_CONCURRENCY, SEARCH_WEB_MAX_ITEMS,
  SEARCH_CANDIDATES_K,
} from './config.js';
import { prefilterCandidates } from './retrieval.js';
import { stageWindow } from './governor.js';
import { shouldStop, getBudgetState } from './budget.js';
import { log, warn } from './util.js';

// Progresso global (a busca é efêmera, então getStatus() não se move) — a UI faz poll disto.
// `failed` = itens que ESGOTARAM erro (fail-open p/ 'none'), ≠ 'none' legítimo → "não analisados".
let _progress = { scanned: 0, total: 0, relevant: 0, failed: 0 };
export function getSearchProgress() {
  return _progress;
}
const resetProgress = (total) => {
  _progress = { scanned: 0, total, relevant: 0, failed: 0 };
};

const snippet = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
const toItem = (a) => ({
  id: a.id,
  url: a.url,
  title: a.title,
  title_pt: a.title_pt,
  summary_pt: a.summary_pt,
  snippet: snippet(a.content),
  source_name: a.source_name || null, // join sources (NULL em linhas órfãs)
  date_iso: a.date_iso || null, // iso_date(published_at) com fallback em extracted_at
});

function bucketize(hits, isTool) {
  const noticias = [];
  const ferramentas = [];
  for (const h of hits) (isTool(h) ? ferramentas : noticias).push(h);
  return { noticias, ferramentas };
}

/**
 * Grava a busca concluída no histórico (`searches`). Congela só ids+vereditos (leve); o custo
 * real fica em llm_usage via run_id (1 run por busca). Fail-open: histórico jamais derruba
 * uma busca que já custou dinheiro. Retorna o id da linha (ou null).
 */
function persistSearch({ origin, query, mode, scope, stats, hits }) {
  try {
    const info = stmts.insertSearch.run({
      run_id: getBudgetState()?.runId ?? null,
      origin: origin || 'cli',
      query,
      mode,
      scope_json: JSON.stringify(scope || {}),
      stats_json: JSON.stringify(stats || {}),
      hits_json: JSON.stringify(hits || []),
    });
    return Number(info.lastInsertRowid);
  } catch (e) {
    warn(`histórico de busca: falha ao salvar (${e.message})`);
    return null;
  }
}

const RANK = { direct: 0, similar: 1 };

/**
 * Julga CADA linha individualmente (1 Flash/artigo) preenchendo `verdicts` (id -> {relation,kind}).
 * Compartilhado pelo modo A do CLI e pela busca hard da web. Fail-open: erro vira 'none' com warn;
 * orçamento (shouldStop/BUDGET_EXCEEDED) NÃO vira 'none' silencioso — conta no retorno (skipped).
 */
async function judgeRowsIndividually(query, rows, verdicts, label = 'A', onEvent = null, spec = null, concurrency = null) {
  // Janela = min(override de env, capacidade atual da lane llm do governador).
  const gate = pLimit(stageWindow(concurrency || SEARCH_FLASH_CONCURRENCY));
  let skipped = 0;
  await Promise.all(
    rows.map((a) =>
      gate(async () => {
        if (shouldStop()) {
          skipped++; // orçamento NÃO pode virar "none" silencioso: conta como não-avaliado
          return;
        }
        let rel = { relation: 'none', kind: 'news' };
        let failedHere = false;
        try {
          rel = await judgeRelevance({ query, title: a.title, content: a.content, spec });
        } catch (e) {
          if (e?.code === 'BUDGET_EXCEEDED') {
            skipped++;
            return;
          }
          warn(`busca[${label}] ${a.url}: ${e.message}`); // fail-open -> none
          failedHere = true;
        }
        _progress.scanned++;
        if (rel.relation !== 'none') _progress.relevant++;
        if (failedHere) _progress.failed++;
        if (_progress.scanned % 25 === 0) {
          log(`busca ${label}: ${_progress.scanned}/${rows.length} avaliados · ${_progress.relevant} relevantes`);
        }
        verdicts.set(a.id, rel);
        // streaming (só a web passa onEvent): hit relevante AO VIVO + progresso por artigo
        if (onEvent) {
          if (rel.relation !== 'none') onEvent({ type: 'hit', hit: { id: a.id, relation: rel.relation, kind: rel.kind } });
          onEvent({ type: 'progress', scanned: _progress.scanned, total: rows.length, relevant: _progress.relevant, failed: _progress.failed });
        }
      }),
    ),
  );
  return skipped;
}

async function runModeA(query, limit, { all = false, runId = null } = {}) {
  const lim = Number.isFinite(limit) ? limit : -1;
  const rows = all || runId == null
    ? stmts.listAllArticlesForSearch.all(lim)
    : stmts.listRunArticlesForSearch.all(runId, lim);
  resetProgress(rows.length);
  const verdicts = new Map();
  const budgetSkipped = await judgeRowsIndividually(query, rows, verdicts, 'A');
  const hits = [];
  for (const a of rows) {
    const rel = verdicts.get(a.id);
    if (!rel || rel.relation === 'none') continue;
    hits.push({ ...toItem(a), relation: rel.relation, score: rel.relation, kind: rel.kind });
  }
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
  { mode = 'A', limit = Infinity, yes = false, all = false, runId = null, origin = 'cli' } = {},
) {
  void yes; // o guard de custo é aplicado no comando (cmdSearch)
  const scope = { all, runId };
  const r = mode === 'B' ? await runModeB(query, limit, scope) : await runModeA(query, limit, scope);
  renderResults(r);
  // Histórico: congela {id, relation, kind, score, bucket} por hit (a restauração re-hidrata
  // título/resumo do acervo e remonta os buckets). Modo B abortado por falta de classificação
  // não conta como busca feita.
  if (!r.needsClassification) {
    const hits = [];
    for (const bucket of ['noticias', 'ferramentas']) {
      for (const h of r.buckets[bucket] || []) {
        hits.push({ id: h.id, relation: h.relation, kind: h.kind ?? null, score: h.score ?? null, bucket });
      }
    }
    r.historyId = persistSearch({
      origin,
      query,
      mode: r.mode,
      scope,
      stats: {
        scanned: r.scanned, total: r.total, relevant: r.relevant,
        skipped: r.skipped || 0, derivedTags: r.derivedTags || undefined,
      },
      hits,
    });
  }
  return r;
}

// ---- busca IA da web (`ncrawl web`): soft em LOTE / hard por artigo, escopo fontes+período ----

// Entrada mínima por artigo no juiz em lote (título + o melhor texto curto disponível).
const toBatchItem = (a) => ({
  id: a.id,
  title: String(a.title || a.title_pt || '').slice(0, 200),
  summary: String(a.summary_pt || a.blurb || a.content_head || '').replace(/\s+/g, ' ').trim().slice(0, 400),
});

// Priorização barata (F4): ordena os PENDENTES por overlap dos termos EN do spec com título+resumo
// — os prováveis-hits entram nos PRIMEIROS lotes (cards relevantes streamam antes; parar no meio
// fica útil). Varre TUDO (não corta recall); só muda a ORDEM. Usa os termos EN do spec (a ponte
// cross-lingual: docs em inglês, query PT já traduzida) — SEM nenhuma chamada LLM extra. No-op sem spec.
const PRIO_STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'new', 'via', 'how', 'using', 'use', 'can', 'its', 'into', 'than', 'has', 'have', 'will', 'not', 'você', 'para', 'com', 'que', 'dos', 'das']);
export function prioritizeBySpec(pend, spec) {
  const src = [...(spec?.terms || []), spec?.query_en || ''].join(' ').toLowerCase();
  const words = [...new Set(src.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !PRIO_STOP.has(w)))];
  if (words.length < 2) return pend; // sinal fraco: mantém a ordem original (mais novo 1º)
  const score = (a) => {
    const hay = `${a.title || ''} ${a.summary_pt || a.blurb || a.content_head || ''}`.toLowerCase();
    let n = 0;
    for (const w of words) if (hay.includes(w)) n++;
    return n;
  };
  return pend
    .map((a, i) => ({ a, i, s: score(a) }))
    .sort((x, y) => y.s - x.s || x.i - y.i) // score DESC; empate mantém a ordem original (estável)
    .map((o) => o.a);
}

/** Divide `rows` em lotes de `size` preservando a ordem (exportada p/ teste). */
export function chunkBatches(rows, size) {
  const n = Math.max(1, Math.floor(size) || 1);
  const out = [];
  for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n));
  return out;
}

/**
 * Funde a resposta de UM lote em `verdicts` (id -> {relation,kind}): id faltando -> 'none'
 * (fail-open), id desconhecido -> ignorado, duplicado -> a primeira entrada vence.
 * Exportada p/ teste. Retorna { missing, unknown }.
 */
export function mergeBatchVerdicts(batch, results, verdicts) {
  const ids = new Set(batch.map((a) => a.id));
  const byId = new Map();
  let unknown = 0;
  for (const r of results || []) {
    if (!ids.has(r.id)) {
      unknown++;
      continue;
    }
    if (!byId.has(r.id)) byId.set(r.id, r);
  }
  let missing = 0;
  for (const a of batch) {
    const v = byId.get(a.id);
    if (!v) {
      verdicts.set(a.id, { relation: 'none', kind: 'news' });
      missing++;
    } else {
      verdicts.set(a.id, { relation: v.relation, kind: v.kind });
    }
  }
  return { missing, unknown };
}

/**
 * Busca da web UI (POST /api/search). deep=false (soft): 1 chamada Flash(xhigh) por lote de
 * SEARCH_BATCH_SIZE artigos, entrada título + summary_pt|blurb|cabeça do content. deep=true
 * (hard): judgeRelevance por artigo (content até SEARCH_MAX_CHARS), como o modo A do CLI.
 * Retorna hits CRUS {id, relation, kind} ordenados (direct antes de similar) e capados em
 * SEARCH_WEB_MAX_ITEMS — o enriquecimento p/ os cards (fonte/data/tags) fica no web.js.
 */
export async function searchWeb(query, { deep = false, sources = null, from = null, to = null, onEvent = null, concurrency = null } = {}) {
  const params = {
    sources: Array.isArray(sources) && sources.length ? JSON.stringify(sources) : null,
    from,
    to,
  };
  let rows = deep
    ? stmts.webSearchCandidates.all(params)
    : stmts.webSearchCandidatesLite.all(params);
  // Pré-filtro LÉXICO (FTS5/BM25): o LLM (caro, O(n)) julga só o top-K candidato em vez do escopo
  // inteiro. Recall léxico por ora — a metade densa (embeddings) amplia p/ paráfrase depois.
  const pf = prefilterCandidates(rows, query, { k: SEARCH_CANDIDATES_K, sources, from, to });
  rows = pf.rows;
  if (pf.prefiltered) {
    onEvent?.({ type: 'prefilter', scope: pf.scope, candidates: rows.length });
    log(`busca: pré-filtro FTS ${pf.scope} -> ${rows.length} candidatos (top-K BM25)`);
  }
  resetProgress(rows.length);
  const verdicts = new Map();
  let skipped = 0;
  const emitProgress = () =>
    onEvent?.({ type: 'progress', scanned: _progress.scanned, total: rows.length, relevant: _progress.relevant, failed: _progress.failed });

  // Entendimento da consulta (1 chamada Pro, amortizada sobre o scan): vira o SPEC (critérios
  // OBRIGATÓRIOS/desejáveis + PT→EN) que TODO lote/artigo julga contra — busca precisão-primeiro.
  // Fail-open: se falhar, segue com a query crua (spec=null → rubrica baseline). Emitido p/ a UI.
  let spec = null;
  if (rows.length) {
    try {
      spec = await compileQuerySpec(query);
      onEvent?.({ type: 'spec', spec });
    } catch (e) {
      warn(`busca: compileQuerySpec falhou (${e.message}); seguindo com a query crua`);
    }
  }

  if (deep) {
    skipped = await judgeRowsIndividually(query, rows, verdicts, 'profunda', onEvent, spec, concurrency);
  } else {
    // Item sem título E sem texto não gasta token: veredito local 'none'.
    const pend = [];
    for (const a of rows) {
      const it = toBatchItem(a);
      if (!it.title && !it.summary) verdicts.set(a.id, { relation: 'none', kind: 'news' });
      else pend.push(a);
    }
    _progress.scanned = rows.length - pend.length;
    emitProgress();
    const gate = pLimit(stageWindow(concurrency || SEARCH_BATCH_CONCURRENCY));
    await Promise.all(
      chunkBatches(prioritizeBySpec(pend, spec), SEARCH_BATCH_SIZE).map((batch) =>
        gate(async () => {
          if (shouldStop()) {
            skipped += batch.length; // orçamento: lote não avaliado (não vira 'none' silencioso)
            return;
          }
          let batchFailed = false;
          try {
            const results = await judgeRelevanceBatch({ query, items: batch.map(toBatchItem), spec });
            const { missing, unknown } = mergeBatchVerdicts(batch, results, verdicts);
            if (missing || unknown) {
              warn(`busca[soft]: lote com ${missing} id(s) sem veredito / ${unknown} desconhecido(s)`);
            }
          } catch (e) {
            if (e?.code === 'BUDGET_EXCEEDED') {
              skipped += batch.length;
              return;
            }
            warn(`busca[soft] lote de ${batch.length}: ${e.message}`); // fail-open -> none
            for (const a of batch) verdicts.set(a.id, { relation: 'none', kind: 'news' });
            batchFailed = true;
          }
          _progress.scanned += batch.length;
          if (batchFailed) _progress.failed += batch.length;
          let rel = 0;
          for (const v of verdicts.values()) if (v.relation !== 'none') rel++;
          _progress.relevant = rel;
          // streaming: emite os hits novos do lote (não no fail-open) + progresso por artigo
          if (onEvent && !batchFailed) {
            for (const a of batch) {
              const v = verdicts.get(a.id);
              if (v && v.relation !== 'none') onEvent({ type: 'hit', hit: { id: a.id, relation: v.relation, kind: v.kind } });
            }
          }
          emitProgress();
        }),
      ),
    );
  }

  const hits = [];
  for (const a of rows) {
    const rel = verdicts.get(a.id);
    if (!rel || rel.relation === 'none') continue;
    hits.push({ id: a.id, relation: rel.relation, kind: rel.kind });
  }
  hits.sort((x, y) => RANK[x.relation] - RANK[y.relation] || y.id - x.id); // direct 1º; empate: mais novo 1º
  const truncated = hits.length > SEARCH_WEB_MAX_ITEMS;
  log(
    `busca web "${query}" (${deep ? 'profunda' : 'soft'}): ${hits.length} relevante(s) de ${rows.length}` +
      (skipped ? ` (${skipped} pulados por orçamento)` : ''),
  );
  const shown = hits.slice(0, SEARCH_WEB_MAX_ITEMS);
  // Histórico: congela o que o usuário VIU (a lista capada; `truncated` registra que havia mais).
  const historyId = persistSearch({
    origin: 'web',
    query,
    mode: deep ? 'deep' : 'soft',
    scope: { sources: Array.isArray(sources) && sources.length ? sources : null, from, to },
    stats: {
      scanned: _progress.scanned, total: rows.length, relevant: hits.length,
      failed: _progress.failed, skipped, truncated, scope: pf.scope, prefiltered: pf.prefiltered,
      spec, // congela o "entendimento" p/ reabrir e mostrar o banner sem repagar LLM
    },
    hits: shown,
  });
  return {
    query,
    deep,
    scanned: _progress.scanned,
    total: rows.length,
    scope: pf.scope,
    prefiltered: pf.prefiltered,
    relevant: hits.length,
    failed: _progress.failed,
    skipped,
    truncated,
    historyId,
    spec, // o "entendimento" da consulta (também vai por evento SSE 'spec' no streaming)
    hits: shown,
  };
}
