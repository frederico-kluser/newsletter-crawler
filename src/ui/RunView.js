// Painel de progresso AO VIVO. Captura os logs do comando via setLogSink (ring buffer, sem
// <Static> p/ não crescer/vazar) e poll das contagens a cada 300ms. O comando é I/O-bound, então
// o event loop fica livre p/ o render do Ink. Cleanup (unmount/Ctrl-C) remove o sink e o intervalo.
import { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { Spinner, Alert, Select } from '@inkjs/ui';
import { html } from './html.js';
import { t } from './i18n.js';
import { setLogSink } from '../util.js';
import { getStatus, getSearchProgress, getRunTelemetry } from '../commands.js';

// Linha compacta de telemetria do run: RAM/lane só quando o governador tem sinal; US$ sempre
// que houver gasto ou orçamento. Ex.: `RAM 62% · llm 12/16 fetch 3/8 render 2/8 · US$ 0.42/2.00`.
function telemetryLine(tele) {
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

// Custo de IA POR ETAPA ao vivo (top 5 por gasto): mostra ONDE o dinheiro está indo em tempo
// real — curadoria/limpeza/verificação/classificação. Lê o mesmo snapshot em memória (sem SQL).
function budgetStageLine(tele) {
  const by = tele?.budget?.byStage;
  if (!by) return null;
  const entries = Object.entries(by)
    .filter(([, s]) => s && s.costUsd > 0)
    .sort((a, b) => b[1].costUsd - a[1].costUsd)
    .slice(0, 5);
  if (!entries.length) return null;
  return 'IA/etapa · ' + entries.map(([stage, s]) => `${stage} $${s.costUsd.toFixed(3)}`).join(' · ');
}

// Linha "o que está acontecendo AGORA" (fases ativas: fetch/render/limpeza/curadoria/verificação…)
// + contadores da run (salvos/blurb/estouros). Snapshot em memória (progress.js), sem SQL.
function progressNowLine(tele) {
  const p = tele?.progress;
  if (!p?.active) return null;
  const parts = [];
  const stages = Object.entries(p.stages || {});
  if (stages.length) parts.push(`${t('nowLabel')}: ` + stages.map(([k, n]) => `${n} ${k}`).join(' · '));
  const c = p.counts || {};
  const novos = (c.salvos || 0) + (c.enriquecidos || 0);
  if (novos || c.mantidosBlurb) {
    parts.push(`✔ ${novos} ${t('savedLabel')}${c.mantidosBlurb ? ` (+${c.mantidosBlurb} blurb)` : ''}`);
  }
  if (c.itensCurados) parts.push(`▤ ${c.itensCurados} curados`);
  if (c.estouros) parts.push(`⏱ ${c.estouros} ${t('timeoutsLabel')}`);
  return parts.length ? parts.join(' · ') : null;
}

// Progresso % rumo à data-alvo (--since): (hoje − data mais antiga vista) ÷ (hoje − alvo),
// global + as fontes mais atrasadas; ✓ = fonte que já ALCANÇOU o piso. Some sem --since.
function progressDateLine(tele) {
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

const LEVEL_COLOR = { warn: 'yellow', error: 'red', debug: 'gray' };
const VISIBLE = 12;

export function RunView({ spec, onDone, onResults }) {
  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState(() => getStatus());
  const [baseline] = useState(() => getStatus());
  const [result, setResult] = useState(null); // { ok, error }
  const [prog, setProg] = useState(null); // progresso da busca (modo A)
  const [tele, setTele] = useState(null); // governador (RAM/lanes) + orçamento
  const mounted = useRef(true);
  const ring = useRef([]);

  useEffect(() => {
    mounted.current = true;
    ring.current = [];
    setLogSink(({ level, text }) => {
      if (!mounted.current) return;
      ring.current.push({ level, text });
      if (ring.current.length > 200) ring.current.shift();
      setLines([...ring.current]);
    });
    const id = setInterval(() => {
      if (!mounted.current) return;
      setStatus(getStatus());
      if (spec.sub === 'search') setProg(getSearchProgress());
      setTele(getRunTelemetry());
    }, 300);
    Promise.resolve()
      .then(() => spec.thunk())
      .then((value) => {
        if (!mounted.current) return;
        if (spec.sub === 'search' && value) {
          onResults?.(value); // App troca p/ a ResultsView com os resultados
          return;
        }
        setResult({ ok: true });
      })
      .catch((e) => mounted.current && setResult({ ok: false, error: e?.message || String(e) }))
      .finally(() => {
        setLogSink(null);
        clearInterval(id);
        if (mounted.current) setStatus(getStatus());
      });
    return () => {
      mounted.current = false;
      setLogSink(null);
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const f = status.frontier;
  const dArticles = Math.max(0, status.articles - baseline.articles);
  const dClassif = Math.max(0, status.classified - baseline.classified);
  // Progresso da run só vale p/ o crawl (outro comando na mesma sessão herdaria snapshot velho).
  const isCrawl = spec.sub === 'crawl';
  const p = isCrawl ? tele?.progress : null;
  const fontes = p?.active && p.sourcesTotal ? `${t('sources')} ${p.sourcesListingDone}/${p.sourcesTotal} · ` : '';
  const counters =
    spec.sub === 'search' && prog
      ? t('searchScanning', { n: prog.scanned, total: prog.total, m: prog.relevant })
      : fontes +
        `${t('articles')} +${dArticles} · ${t('classif')} +${dClassif} · ` +
        `${t('frontier')} ${f.pending}/${f.in_progress}/${f.done}/${f.failed}`;
  const nowLine = isCrawl ? progressNowLine(tele) : null;
  const dateLine = isCrawl ? progressDateLine(tele) : null;

  return html`<${Box} flexDirection="column">
    <${Box}>
      ${result
        ? html`<${Alert} variant=${result.ok ? 'success' : 'error'}>${
            result.ok ? t('done') : `${t('failed')}${result.error ? ': ' + result.error : ''}`
          }</${Alert}>`
        : html`<${Spinner} label=${`${t('running')} (${spec.sub})`} />`}
    </${Box}>
    <${Box} marginY=${1}><${Text} color="cyan">${counters}</${Text}></${Box}>
    ${nowLine ? html`<${Box}><${Text} color="green">${nowLine}</${Text}></${Box}>` : null}
    ${dateLine ? html`<${Box}><${Text} color="magenta">${dateLine}</${Text}></${Box}>` : null}
    ${telemetryLine(tele) ? html`<${Box}><${Text} dimColor>${telemetryLine(tele)}</${Text}></${Box}>` : null}
    ${budgetStageLine(tele) ? html`<${Box}><${Text} dimColor>${budgetStageLine(tele)}</${Text}></${Box}>` : null}
    <${Box} flexDirection="column" height=${VISIBLE}>
      ${lines.slice(-VISIBLE).map((l, i) =>
        html`<${Text} key=${i} color=${LEVEL_COLOR[l.level]} wrap="truncate-end">${l.text}</${Text}>`,
      )}
    </${Box}>
    ${result
      ? html`<${Select}
          options=${[
            { label: t('backToMenu'), value: 'menu' },
            { label: t('quit'), value: 'quit' },
          ]}
          onChange=${onDone}
        />`
      : null}
  </${Box}>`;
}
