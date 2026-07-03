// Construtores de LINHAS de telemetria da run (strings puras de `tele`), compartilhados pelo
// CrawlDashboard (faixa de métricas + % por data) e pelo GenericRun (telemetria + custo/etapa dos
// comandos não-crawl). Extraídos do RunView p/ um lugar só. Sem Ink: retornam string|null.
import { t } from './i18n.js';

// Linha compacta de telemetria do run: RAM/lane só quando o governador tem sinal; US$ sempre que
// houver gasto ou orçamento. Ex.: `RAM 62% · llm 12/16 fetch 3/8 render 2/8 · US$ 0.42/2.00`.
export function telemetryLine(tele) {
  if (!tele) return null;
  const parts = [];
  const g = tele.governor;
  if (g?.ram?.totalBytes) {
    parts.push(`RAM ${g.ram.usedPct}%${g.ram.state !== 'ok' ? ` (${g.ram.state})` : ''}`);
    const l = g.lanes;
    parts.push(
      `llm ${l.llm.active}/${l.llm.capacity} fetch ${l.fetch.active}/${l.fetch.capacity} ` +
        `render ${l.render.active}/${l.render.capacity}`,
    );
  }
  const b = tele.budget;
  if (b && (b.spentUsd > 0 || b.budgetUsd > 0)) {
    let money = `US$ ${b.spentUsd.toFixed(2)}${b.budgetUsd > 0 ? `/${b.budgetUsd.toFixed(2)}` : ''}`;
    if (b.calls > 0) money += ` · ${b.calls} ch`;
    if (b.reservedUsd > 0.001) money += ` · +${b.reservedUsd.toFixed(2)} em voo`;
    parts.push(money);
  }
  return parts.length ? parts.join(' · ') : null;
}

// Custo de IA POR ETAPA ao vivo (top 5 por gasto): mostra ONDE o dinheiro está indo em tempo real —
// curadoria/limpeza/verificação/classificação. Lê o mesmo snapshot em memória (sem SQL).
export function budgetStageLine(tele) {
  const by = tele?.budget?.byStage;
  if (!by) return null;
  const entries = Object.entries(by)
    .filter(([, s]) => s && s.costUsd > 0)
    .sort((a, b) => b[1].costUsd - a[1].costUsd)
    .slice(0, 5);
  if (!entries.length) return null;
  return 'IA/etapa · ' + entries.map(([stage, s]) => `${stage} $${s.costUsd.toFixed(3)}`).join(' · ');
}

// Progresso % rumo à data-alvo (--since): (hoje − data mais antiga vista) ÷ (hoje − alvo), global +
// as fontes mais atrasadas; ✓ = fonte que já ALCANÇOU o piso. Some sem --since.
export function progressDateLine(tele) {
  const p = tele?.progress;
  if (!p?.active || !p.since || p.pctGlobal == null) return null;
  const atras = p.sources
    .filter((s) => s.pct != null)
    .sort((a, b) => a.pct - b.pct)
    .slice(0, 3)
    .map((s) => `${s.name} ${s.floorHit ? '✓' : `${s.pct}%`}`);
  const semData = p.sources.filter((s) => s.pct == null).length;
  let line = `${t('targetLabel')} ${p.since}: ${p.pctGlobal}%`;
  if (atras.length) line += ` · ${atras.join(' · ')}`;
  if (semData) line += ` · ${semData} ${t('noDateLabel')}`;
  return line;
}

// Linha "agora:" — só as FASES ATIVAS (fetch/render/limpeza/curadoria/verificação/resumo/…), sem os
// contadores acumulados (esses já aparecem na tabela de fases do dashboard). Ex.: `agora: 3 fetch · 2 render`.
export function nowStagesLine(tele) {
  const stages = Object.entries(tele?.progress?.stages || {});
  if (!stages.length) return null;
  return `${t('nowLabel')}: ${stages.map(([k, n]) => `${n} ${k}`).join(' · ')}`;
}
