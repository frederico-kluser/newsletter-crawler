// Derivação PURA (sem Ink/React/i18n) do estado das FASES do crawl a partir do snapshot vivo
// (getStatus().frontier + getRunTelemetry().progress). Testável direto. Cada fase vira uma linha
// { key, state:'idle'|'active'|'done', value:0-100|null, counters:string } — o CrawlDashboard só
// pinta (o rótulo localizado vem de t('phase_'+key)). `counters` fica em PT (vocabulário de domínio
// do crawl, que os logs já mantêm em PT); o rótulo e o resto do chrome é que são bilíngues.
const num = (x) => (Number.isFinite(x) ? x : 0);
const pct = (n, d) => (d > 0 ? Math.max(0, Math.min(100, Math.round((n / d) * 100))) : null);

/**
 * @param {object} status  getStatus() — usa .frontier
 * @param {object} tele     getRunTelemetry() — usa .progress
 * @param {{result?:{ok:boolean}|null}} opts  result≠null quando a run terminou
 * @returns {Array<{key,state,value,counters}>}
 */
export function derivePhases(status, tele, { result = null } = {}) {
  const P = tele?.progress || {};
  const F = status?.frontier || { pending: 0, in_progress: 0, done: 0, failed: 0 };
  const St = P.stages || {};
  const C = P.counts || {};
  const saved = num(C.salvos) + num(C.enriquecidos);
  const srcTotal = num(P.sourcesTotal);
  const srcDone = num(P.sourcesListingDone);

  // --- Descoberta: varre as listagens/índices até concluir cada fonte. Barra = fontes concluídas.
  const discActive = srcTotal > 0 && srcDone < srcTotal;
  const discDone = srcTotal > 0 && srcDone >= srcTotal;

  // --- Curadoria: só relevante quando há issues de índice sendo curadas por IA.
  const curActive = num(St['curadoria']) > 0;
  const curRelevant = num(C.issues) > 0 || curActive;
  const curDone = num(C.issues) > 0 && !curActive && discDone;

  // --- Artigos: pipeline fetch→render→limpeza→save. Barra = burn-down da FILA DA RUN, medido do
  // `jobsBase` (fronteira pós-seed) p/ frente: jobs terminais (done+failed) sobre a fila conhecida
  // da run (terminais + pendentes + em voo). O frontier é GLOBAL (milhares de artigos de runs
  // antigas) — sem o delta por jobsBase a barra nascia 100% cheia com "0 salvos". Sem base → sem
  // barra (nunca uma barra mentirosa). Retries re-enfileiram sem mexer no delta (só estados
  // terminais contam), então a barra não retrocede por causa deles.
  const base = P.jobsBase;
  const terminal = base
    ? Math.max(0, num(F.done) - num(base.done) + num(F.failed) - num(base.failed))
    : null;
  const artActive = num(St.fetch) > 0 || num(St.render) > 0 || num(St['limpeza']) > 0 || num(F.in_progress) > 0;
  const artStarted = saved > 0 || (terminal != null && terminal > 0) || artActive;
  const artDone = discDone && num(F.pending) === 0 && num(F.in_progress) === 0 && (saved > 0 || (terminal != null && terminal > 0));

  // --- Pós-processamento: verify/resumo/classify em streaming + sweeps finais. Barra = verificados/salvos.
  const postActive = num(St['verificação']) > 0 || num(St.resumo) > 0 || num(St['classificação']) > 0;
  const postTouched = num(C.verificados) + num(C.resumidos) + num(C.classificados) > 0;
  const postDone = result != null;

  const phases = [
    {
      key: 'discovery',
      state: discDone ? 'done' : discActive ? 'active' : 'idle',
      value: pct(srcDone, srcTotal),
      counters: `${srcDone}/${srcTotal || '?'} fontes`,
    },
  ];
  if (curRelevant) {
    phases.push({
      key: 'curation',
      // Já curou alguma issue (issues>0) mas nenhuma AGORA e a descoberta segue → "em andamento".
      state: curDone ? 'done' : curActive || num(C.issues) > 0 ? 'active' : 'idle',
      value: null,
      counters: `${num(C.issues)} ${num(C.issues) === 1 ? 'coletânea' : 'coletâneas'} · ${num(C.itensCurados)} itens`,
    });
  }
  phases.push({
    key: 'articles',
    state: artDone ? 'done' : artStarted ? 'active' : 'idle',
    value: terminal == null ? null : pct(terminal, terminal + num(F.pending) + num(F.in_progress)),
    counters:
      `${saved} salvos` +
      (num(F.in_progress) ? ` · ${num(F.in_progress)} ativos` : '') +
      (num(C.mantidosBlurb) ? ` · ${num(C.mantidosBlurb)} c/ resumo` : '') +
      (num(C.estouros) ? ` · ${num(C.estouros)} ⏱` : ''),
  });
  phases.push({
    key: 'post',
    state: postDone ? 'done' : postActive || postTouched ? 'active' : 'idle',
    value: saved > 0 ? pct(num(C.verificados), saved) : null,
    counters: `${num(C.verificados)}v · ${num(C.resumidos)}r · ${num(C.classificados)}c`,
  });
  // Run concluída com sucesso: assenta todas as fases em ✓ (nada mais está "ativo" no fim).
  if (result && result.ok) return phases.map((p) => ({ ...p, state: 'done' }));
  return phases;
}

/** Estado global da run p/ o badge do cabeçalho: preparando→coletando→finalizando→done/failed. */
export function deriveBadge(status, tele, { result = null } = {}) {
  if (result) return result.ok ? 'done' : 'failed';
  const P = tele?.progress || {};
  const St = P.stages || {};
  const C = P.counts || {};
  if (!P.active) return 'preparando';
  const srcTotal = num(P.sourcesTotal);
  const srcDone = num(P.sourcesListingDone);
  const articleWork = num(St.fetch) + num(St.render) + num(St['limpeza']) > 0 || num(status?.frontier?.in_progress) > 0;
  const postWork = num(St['verificação']) + num(St.resumo) + num(St['classificação']) > 0;
  // Finalizando: descoberta acabou, sem artigo em voo, e só resta o pós/sweeps trabalhando.
  if (srcTotal > 0 && srcDone >= srcTotal && !articleWork && (postWork || num(C.verificados) + num(C.resumidos) + num(C.classificados) > 0)) {
    return 'finalizando';
  }
  const started = srcDone > 0 || articleWork || num(C.salvos) + num(C.enriquecidos) > 0 || Object.keys(St).length > 0;
  return started ? 'coletando' : 'preparando';
}
