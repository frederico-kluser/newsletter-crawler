// Verificação pós-cadastro: cada artigo salvo recebe um veredito ok|suspect|junk + notas
// (persistidos em articles.verify_status/verify_notes e no trace de events) — é o "conferir o
// que foi feito a cada cadastro". Heurística barata primeiro (anti-bot óbvio), LLM (Flash) no
// resto, em paralelo pela lane llm. Idempotente (verify_status IS NULL) e retomável — espelha
// summarize.js. Nunca apaga: junk é marcado e aparece no `ncrawl inspect`.
import pLimit from 'p-limit';
import { stmts } from './db.js';
import { verifyRecordLLM, cleanArticleContent } from './llm.js';
import { isBlockedPage, applyJunkSpans, ensurePlainText } from './clean.js';
import { logEvent } from './events.js';
import { VERIFY_CONCURRENCY, VERIFY_MAX_CHARS, CLEAN_MAX_CHARS } from './config.js';
import { stageWindow } from './governor.js';
import { shouldStop, getBudgetState } from './budget.js';
import { sha256, log, errorLog } from './util.js';

/**
 * Verifica UMA ficha (heurística grátis anti-bot -> LLM), persiste o veredito + notas e loga o
 * evento. Compartilhado pelo sweep (verifyPending) e pela verificação em STREAMING do crawl
 * (commands.js), logo após cada enriquecimento. `a` precisa de {id,url,title,kind,blurb,content}.
 */
export async function verifyArticleRow(a, { runId = null } = {}) {
  let verdict;
  let problems;
  if (isBlockedPage(a.title, a.content)) {
    verdict = 'junk';
    problems = ['página de desafio anti-bot salva como conteúdo'];
  } else {
    const out = await verifyRecordLLM({
      url: a.url,
      kind: a.kind,
      title: a.title,
      blurb: a.blurb,
      content: String(a.content || '').slice(0, VERIFY_MAX_CHARS),
    });
    verdict = out.verdict;
    problems = out.problems;
  }
  stmts.setVerify.run({
    id: a.id,
    verify_status: verdict,
    verify_notes: problems.length ? problems.join('; ') : null,
  });
  logEvent({ runId, url: a.url, stage: 'verify', status: verdict, detail: problems.length ? { problems } : null });
  return { verdict, problems };
}

/** Verifica os artigos sem veredito (ou todos, com force). Retorna { verified, byVerdict }. */
export async function verifyPending({ limit = Infinity, force = false } = {}) {
  const lim = Number.isFinite(limit) ? limit : -1; // SQLite: LIMIT -1 = sem limite
  const rows = force
    ? stmts.listArticlesForReverify.all(lim)
    : stmts.listArticlesToVerify.all(lim);
  if (!rows.length) {
    log('verify: nada a verificar.');
    return { verified: 0, byVerdict: {} };
  }
  const runId = getBudgetState().runId ?? null; // events apontam p/ a run que VERIFICOU
  log(`verify: ${rows.length} artigo(s) — veredito ok|suspect|junk, force=${force}.`);

  const gate = pLimit(stageWindow(VERIFY_CONCURRENCY));
  const byVerdict = {};
  let done = 0;
  let skipped = 0;
  await Promise.all(
    rows.map((a) =>
      gate(async () => {
        if (shouldStop()) {
          skipped++;
          return; // orçamento: a linha NULL segue retomável via `ncrawl verify`
        }
        try {
          const { verdict, problems } = await verifyArticleRow(a, { runId });
          byVerdict[verdict] = (byVerdict[verdict] || 0) + 1;
          done++;
          if (verdict !== 'ok') {
            log(`verify ${verdict} [${done}/${rows.length}] ${(a.title || a.url).slice(0, 60)} — ${problems.join('; ').slice(0, 120)}`);
          }
        } catch (e) {
          if (e?.code === 'BUDGET_EXCEEDED') {
            skipped++;
            return;
          }
          errorLog(`verify falhou (${a.url}): ${e.message}`);
        }
      }),
    ),
  );

  const parts = Object.entries(byVerdict).map(([k, n]) => `${k}=${n}`).join(' ');
  log(
    `verify concluído: ${done}/${rows.length} (${parts || '—'})` +
      `${skipped ? ` (${skipped} pulados por orçamento — retome com \`ncrawl verify\`)` : ''}.`,
  );
  return { verified: done, byVerdict };
}

/**
 * Re-limpa os vereditos 'suspect' com um passe FORTE (Pro, stage articleReclean) e re-verifica —
 * a melhoria da seção 7: um "falso-sujo" auditável pode virar 'ok' com uma limpeza melhor. Mesma
 * mecânica do pré-save (junk_spans -> remoção local exata + guarda anti over-deletion + texto puro),
 * agora com o modelo caro. Idempotente/retomável (o item segue 'suspect' se pular por orçamento).
 */
export async function recleanSuspects({ limit = Infinity } = {}) {
  const lim = Number.isFinite(limit) ? limit : -1;
  const rows = stmts.listSuspectArticles.all(lim);
  if (!rows.length) {
    log('reclean: nenhum suspect a reprocessar.');
    return { recleaned: 0, upgraded: 0 };
  }
  const runId = getBudgetState().runId ?? null;
  log(`reclean: ${rows.length} suspect(s) — limpeza forte (Pro) + re-verify.`);

  const gate = pLimit(stageWindow(VERIFY_CONCURRENCY));
  let recleaned = 0;
  let upgraded = 0;
  let skipped = 0;
  await Promise.all(
    rows.map((a) =>
      gate(async () => {
        if (shouldStop()) {
          skipped++;
          return; // orçamento: o item segue 'suspect', retomável com `ncrawl reclean`
        }
        try {
          const full = String(a.content || '');
          const head = full.slice(0, CLEAN_MAX_CHARS);
          const tail = full.length > CLEAN_MAX_CHARS ? full.slice(CLEAN_MAX_CHARS) : '';
          const out = await cleanArticleContent({ title: a.title, content: head, stage: 'articleReclean' });
          const res = applyJunkSpans(head, out.junk_spans);
          if (!res.rejected && res.applied > 0) {
            const content = ensurePlainText(res.text + tail);
            const hash = sha256(content);
            const dup = stmts.getArticleByHash.get(hash);
            if (!dup || dup.id === a.id) {
              stmts.setContentCleaned.run({ id: a.id, content, content_hash: hash });
              a.content = content; // o re-verify abaixo já enxerga o texto novo
              recleaned++;
              logEvent({ runId, url: a.url, stage: 'clean', status: 'reclean', detail: { spans: res.applied, removidos: res.removed } });
            }
          }
          const { verdict } = await verifyArticleRow(a, { runId });
          if (verdict === 'ok') upgraded++;
        } catch (e) {
          if (e?.code === 'BUDGET_EXCEEDED') {
            skipped++;
            return;
          }
          errorLog(`reclean falhou (${a.url}): ${e.message}`);
        }
      }),
    ),
  );

  log(
    `reclean concluído: ${recleaned} re-limpo(s), ${upgraded} viraram ok` +
      `${skipped ? ` (${skipped} pulados por orçamento — retome com \`ncrawl reclean\`)` : ''}.`,
  );
  return { recleaned, upgraded };
}
