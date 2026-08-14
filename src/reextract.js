// `ncrawl reextract`: RE-EXTRAI do zero o conteúdo de artigos já salvos (P5/P6 da captura
// 2026-08-14): re-fetch do HTML-fonte + re-parse (Readability com quebras de bloco) + 2º passe
// do GitHub (fim truncado) + limpeza IA (com moldura determinística no fallback) + UPDATE +
// RE-VERIFY (verifyArticleRow — verify.js não é editado). Difere do `reclean`, que só remove
// junk_spans do texto SALVO: aqui a extração é refeita do HTML.
// Sem rede no teste: fetchSmartImpl é injetável (default = fetchSmart real).
import pLimit from 'p-limit';
import { stmts } from './db.js';
import { fetchSmart } from './fetch.js';
import {
  extractArticleAsync, capHtml, htmlBlockText, ensurePlainText,
  applyJunkSpans, prunePageFrame, isGithubUrl, isBlockedPage, fallbackTitle,
} from './clean.js';
import { getCachedSelector, validateContentSelector } from './selectors.js';
import { cleanArticleContent } from './llm.js';
import { verifyArticleRow } from './verify.js';
import { githubTruncationFix } from './crawl.js';
import { logEvent } from './events.js';
import { HAS_LLM, CLEAN_BEFORE_SAVE, CLEAN_MAX_CHARS } from './config.js';
import { shouldStop, getBudgetState } from './budget.js';
import { sha256, domainSig, log, warn, errorLog, clampFutureDate } from './util.js';

const REEXTRACT_CONCURRENCY = 3;

// Default do CLI `ncrawl reextract` sem --limit: varredura PEQUENA; completa exige --all
// (ou --limit grande). Sem isso, uma migração acidental reescreve o corpus inteiro.
export const REEXTRACT_DEFAULT_LIMIT = 20;

// Réplica da guarda do crawl (crawl.js isErrorPage — função privada daquele módulo): o
// reextract é o ÚNICO outro caminho que sobrescreve conteúdo salvo, então aplica a MESMA
// detecção. Página de erro (404/500/parqueada) vem com 200 e corpo grande — o título
// extraído é o sinal (o título SALVO do agregador não carrega erro).
function isErrorPage(title, content) {
  const t = (title || '').toLowerCase().trim();
  if (/^(404|403|500|502|503)(\s|-|$)/.test(t)) return true;
  if (/^not found$/i.test(t)) return true;
  if (/^(page|página)\s+not\s+found/i.test(t)) return true;
  if (/^(error|erro)\b/i.test(t) && (content || '').length < 200) return true;
  const c = (content || '').toLowerCase().trim();
  if (c.length < 100 && /\b(not found|404|403|500|error|erro)\b/i.test(c)) return true;
  return false;
}

/**
 * Re-extrai UM artigo (mesma cadeia do crawl: Readability -> [2º passe GitHub] -> clean IA com
 * moldura no fallback -> ensurePlainText) e persiste content/content_hash/published_at via
 * enrichArticle (não toca kind/blurb/section). published_at só muda p/ item AVULSO (sem
 * issue_url) — item de issue NUNCA adota a data do alvo (P1 da captura 2026-08-14). Retorna
 * { status: 'updated'|'no-content'|'dup-hash', verdict?, chars? }.
 */
async function reextractOne(row, { fs }) {
  const fetched = await fs(row.url, { profile: 'article', aggressive: true });
  const html = fetched.html;
  const finalUrl = fetched.url || row.url;
  // Ficha COMPLETA p/ a âncora de data: o stmt da lista não traz issue_url, e item de ISSUE
  // nunca pode adotar a data do alvo (P1 da captura 2026-08-14).
  const full = stmts.getArticleFullByUrl.get(row.url) || row;

  // 1) Readability (mesma ordem do crawl); o fallback LLM de extração fica de FORA (custo) —
  // fail-open: sem conteúdo extraível, a ficha antiga é mantida.
  const art = await extractArticleAsync(capHtml(html), finalUrl);
  let content = null;
  let method = null;
  let published = null;
  if (art?.textContent && art.textContent.trim().length >= 400) {
    content = htmlBlockText(art);
    method = 'readability';
    published = art.publishedTime || null;
  } else {
    const sig = domainSig(row.url, 'article');
    const csel = getCachedSelector(sig);
    if (csel?.content_selector) {
      const v = validateContentSelector(html, csel.content_selector);
      if (v.ok) {
        content = v.result.text;
        method = 'content-selector';
      }
    }
  }
  // Guards do crawl (crawl.js:732-753) ANTES de sobrescrever o salvo: página de erro
  // (404/500/parqueada) e interstitial anti-bot vêm com 200 e corpo GRANDE — sem isso, um
  // re-fetch ruim trocaria o corpo bom por lixo PERMANENTE. Título = o da re-extração (como
  // no crawl; o título SALVO do agregador não carrega o sinal de erro). Item curado e avulso:
  // alvo ruim NUNCA substitui a versão atual — o crawl chama isso de keepAggregatorVersion
  // (crawl.js:575); aqui o registro nem volta p/ enrich (não é needs_enrich), só não é tocado.
  const keepCurrent = (reason, extra = {}) => {
    logEvent({
      runId: getBudgetState().runId ?? null, url: row.url, stage: 'reextract',
      status: full.issue_url ? 'kept-blurb' : 'skip',
      detail: { reason, ...extra },
    });
    warn(`reextract: ${reason} — mantendo ficha atual: ${row.url.slice(0, 60)}`);
    return { status: full.issue_url ? 'kept-blurb' : 'skip' };
  };
  const extractedTitle = art?.title || fallbackTitle(html) || row.title;
  if (isErrorPage(extractedTitle, content)) return keepCurrent('error-page', { title: extractedTitle });
  if (!content || content.length < 50) return { status: 'no-content' };
  if (isBlockedPage(extractedTitle, content)) return keepCurrent('blocked-page', { title: extractedTitle });

  // 2) Limpeza IA (mesmo fluxo do crawl); no catch e no caminho sem LLM, a moldura de página
  // sai DETERMINÍSTICA (prunePageFrame) — o original nunca mais é salvo com byline/rodapé.
  let cleaned = 0;
  if (HAS_LLM && CLEAN_BEFORE_SAVE) {
    try {
      const head = content.slice(0, CLEAN_MAX_CHARS);
      const tail = content.length > CLEAN_MAX_CHARS ? content.slice(CLEAN_MAX_CHARS) : '';
      const out = await cleanArticleContent({ title: row.title, content: head });
      cleaned = 1;
      const res = applyJunkSpans(head, out.junk_spans);
      if (res.rejected) {
        warn(`reextract: limpeza rejeitada (${res.reason}) — mantendo o extraído: ${row.url.slice(0, 60)}`);
      } else if (res.applied > 0) {
        content = res.text + tail;
      }
    } catch (e) {
      if (e?.code === 'BUDGET_EXCEEDED') throw e;
      warn(`reextract: limpeza IA falhou (${row.url}): ${e.message} — aplicando moldura determinística`);
      content = ensurePlainText(prunePageFrame(content));
    }
  } else if (!HAS_LLM) {
    // Sem LLM o clean não roda: o conserto determinístico do catch vale igualmente aqui.
    content = prunePageFrame(content);
  }

  // 3) P5 DEPOIS do clean (mesma ordem do crawl): o clean tira o banner do topo, aí o 2º passe
  // do GitHub (container da release) fica mais longo que o atual e entra.
  if (method === 'readability' && isGithubUrl(finalUrl)) {
    const fix = await githubTruncationFix(content, html, finalUrl);
    if (fix.changed) content = fix.content;
  }
  content = ensurePlainText(content);

  // 4) Persiste via enrichArticle (não toca kind/blurb/section; needs_enrich já é 0).
  const hash = sha256(content);
  const dup = stmts.getArticleByHash.get(hash);
  if (dup && dup.id !== row.id) return { status: 'dup-hash' };
  // Data futura (post agendado/fuso) clampada como no crawl (crawl.js:839) — sem isso, a
  // data do alvo re-extraída flutua no topo das superfícies ordenadas por data. Item de issue
  // continua com a âncora da curadoria (P1 preservado).
  const publishedAt = full.issue_url ? full.published_at : clampFutureDate(published || full.published_at);
  stmts.enrichArticle.run({
    id: row.id,
    title: row.title,
    content,
    content_hash: hash,
    published_at: publishedAt,
    content_source: 'target',
    cleaned,
  });
  logEvent({
    runId: getBudgetState().runId ?? null, url: row.url, stage: 'reextract', status: 'ok',
    detail: { method, chars: content.length, publishedAt },
  });

  // 5) Re-verificação (mesma função do crawl/verify — não edita verify.js).
  if (HAS_LLM) {
    const { verdict } = await verifyArticleRow(
      { id: row.id, url: row.url, title: row.title, kind: row.kind, blurb: row.blurb, content },
      { runId: getBudgetState().runId ?? null },
    );
    return { status: 'updated', verdict, chars: content.length };
  }
  return { status: 'updated', chars: content.length };
}

/**
 * Re-extrai os artigos com conteúdo do ALVO (content_source='target' — blurb-only não tem o
 * que re-extrair), opcionalmente filtrando por substring da URL. Respeita o orçamento
 * (shouldStop) e é retomável (as fichas puladas ficam intactas). Retorna contadores.
 */
export async function reextractTargets({ urlFilter = null, limit = REEXTRACT_DEFAULT_LIMIT, fetchSmartImpl = null } = {}) {
  const fs = fetchSmartImpl || fetchSmart;
  const filter = urlFilter ? String(urlFilter).toLowerCase() : null;
  const rows = stmts
    .listArticlesForReverify.all(-1)
    .filter((r) => r.content_source === 'target')
    .filter((r) => !filter || (r.url || '').toLowerCase().includes(filter))
    .slice(0, Number.isFinite(limit) ? limit : undefined);
  if (!rows.length) {
    log(`reextract: nada a re-extrair${filter ? ` (filtro "${urlFilter}")` : ''}.`);
    return { reextracted: 0, skipped: 0, byVerdict: {} };
  }
  log(
    `reextract: ${rows.length} artigo(s) — re-fetch + re-parse + re-clean + re-verify` +
      `${HAS_LLM ? '' : ' (sem chave LLM: sem clean/verify — só a re-extração determinística)'}.`,
  );
  const gate = pLimit(REEXTRACT_CONCURRENCY);
  let reextracted = 0;
  let skipped = 0;
  const byVerdict = {};
  await Promise.all(
    rows.map((row) =>
      gate(async () => {
        if (shouldStop()) {
          skipped++; // orçamento: a ficha fica intacta (retomável com `ncrawl reextract`)
          return;
        }
        try {
          const out = await reextractOne(row, { fs });
          if (out.status === 'updated') {
            reextracted++;
            if (out.verdict) byVerdict[out.verdict] = (byVerdict[out.verdict] || 0) + 1;
            log(`reextract ok [${out.chars}ch, ${out.verdict || 'sem-verify'}]: ${(row.title || row.url).slice(0, 60)}`);
          } else {
            skipped++;
            log(`reextract ${out.status} (mantido): ${(row.title || row.url).slice(0, 60)}`);
          }
        } catch (e) {
          if (e?.code === 'BUDGET_EXCEEDED') {
            skipped++;
            return;
          }
          errorLog(`reextract falhou (${row.url}): ${e.message}`);
          skipped++;
        }
      }),
    ),
  );
  const verdicts = Object.keys(byVerdict).length
    ? ` (${Object.entries(byVerdict).map(([k, n]) => `${k}=${n}`).join(' ')})`
    : '';
  log(`reextract concluído: ${reextracted} re-extraído(s), ${skipped} pulado(s)${verdicts}.`);
  return { reextracted, skipped, byVerdict };
}
