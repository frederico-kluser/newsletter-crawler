// Pós-processamento: resumo + título em PT-BR por artigo (p/ leitura). O `content` original
// é mantido (busca/tags usam ele). 1 chamada/artigo, gate único, idempotente (NULL-only) e
// retomável — espelha classify.js, mas sem o fan-out por faceta.
import pLimit from 'p-limit';
import { stmts } from './db.js';
import { summarizeArticle } from './llm.js';
import { SUMMARIZE_CONCURRENCY, SUMMARIZE_MAX_CHARS } from './config.js';
import { log, errorLog } from './util.js';

/** Resume os artigos sem summary_pt (ou todos, com force). Retorna { summarized, total }. */
export async function summarizePending({ limit = Infinity, force = false } = {}) {
  const lim = Number.isFinite(limit) ? limit : -1; // SQLite: LIMIT -1 = sem limite
  const rows = force
    ? stmts.listArticlesForResummarize.all(lim)
    : stmts.listArticlesNeedingSummary.all(lim);
  if (!rows.length) {
    log('summarize: nada a resumir.');
    return { summarized: 0, total: 0 };
  }
  log(`summarize: ${rows.length} artigo(s) — PT-BR, force=${force}.`);

  const gate = pLimit(SUMMARIZE_CONCURRENCY);
  let done = 0;
  await Promise.all(
    rows.map((a) =>
      gate(async () => {
        try {
          const { title_pt, summary_pt } = await summarizeArticle({
            title: a.title,
            content: String(a.content || '').slice(0, SUMMARIZE_MAX_CHARS),
          });
          stmts.setSummary.run({ id: a.id, title_pt, summary_pt });
          done++;
          log(`summarize ok [${done}/${rows.length}] ${(a.title || a.url || '').slice(0, 60)}`);
        } catch (e) {
          errorLog(`summarize falhou (${a.url}): ${e.message}`);
        }
      }),
    ),
  );

  log(`summarize concluído: ${done}/${rows.length}.`);
  return { summarized: done, total: rows.length };
}
