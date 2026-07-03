// Dispatcher do painel de execução. Possui o ciclo comum a TODOS os comandos: roda o thunk, faz o
// poll das contagens (300ms), captura os logs via setLogSink (ring de 200, sem <Static> p/ não
// vazar entre runs) e assina o fluxo de MARCOS (run-events). Para o CRAWL renderiza o CrawlDashboard
// (status persistente + feed curado); para os demais comandos (busca/classify/…) mantém o painel
// simples de sempre (GenericRun). O sink agora serve ao overlay verbose + à contagem de avisos +
// ao roteamento de erros p/ o feed. Teardown (unmount/Ctrl-C/fim) remove sink, intervalo E a
// assinatura — no `.finally` E no cleanup do effect. Comando I/O-bound → event loop livre p/ o Ink.
import { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner, Alert, Select } from '@inkjs/ui';
import { html } from './html.js';
import { t } from './i18n.js';
import { setLogSink } from '../util.js';
import { getStatus, getSearchProgress, getRunTelemetry } from '../commands.js';
import { subscribeRunEvents, emitRunEvent, bumpWarnCount } from '../run-events.js';
import { CrawlDashboard } from './CrawlDashboard.js';
import { telemetryLine, budgetStageLine } from './runLines.js';

const LEVEL_COLOR = { warn: 'yellow', error: 'red', debug: 'gray' };
const VISIBLE = 12;

export function RunView({ spec, onDone, onResults }) {
  const isCrawl = spec.sub === 'crawl';
  const [lines, setLines] = useState([]); // log cru (overlay verbose / GenericRun)
  const [status, setStatus] = useState(() => getStatus());
  const [baseline] = useState(() => getStatus());
  const [result, setResult] = useState(null); // { ok, error }
  const [prog, setProg] = useState(null); // progresso da busca (modo A)
  const [tele, setTele] = useState(null); // governador (RAM/lanes) + orçamento + progresso
  const [feed, setFeed] = useState([]); // marcos curados (crawl)
  const [ticker, setTicker] = useState(null); // último "salvo" (crawl)
  const [warnCount, setWarnCount] = useState(0); // avisos internos colapsados (crawl)
  const [verbose, setVerbose] = useState(false); // overlay de log cru (tecla v)
  const mounted = useRef(true);
  const ring = useRef([]);
  const startAt = useRef(Date.now());

  // Tecla no crawl: `v` alterna o log cru; `q` sai (jobs in_progress retomam no próximo run).
  useInput(
    (input) => {
      if (input === 'v') setVerbose((x) => !x);
      else if (input === 'q') onDone?.('quit');
    },
    { isActive: isCrawl },
  );

  useEffect(() => {
    mounted.current = true;
    ring.current = [];
    setLogSink(({ level, text }) => {
      if (!mounted.current) return;
      ring.current.push({ level, text });
      if (ring.current.length > 200) ring.current.shift();
      setLines([...ring.current]);
      // Ruído interno (warn/plumbing) é COLAPSADO num contador; erros reais afloram no feed.
      if (isCrawl && level === 'warn') bumpWarnCount(1);
      if (isCrawl && level === 'error') emitRunEvent({ phase: 'run', kind: 'error', level: 'error', detail: text });
    });
    const unsub = subscribeRunEvents((s) => {
      if (!mounted.current) return;
      setFeed(s.feed.slice());
      setTicker(s.ticker);
      setWarnCount(s.warnCount);
    });
    const id = setInterval(() => {
      if (!mounted.current) return;
      setStatus(getStatus());
      if (spec.sub === 'search') setProg(getSearchProgress());
      setTele(getRunTelemetry());
    }, 300);
    id.unref?.(); // o poll nunca segura o processo (o Ink mantém o loop enquanto renderiza)
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
      .catch((e) => {
        if (!mounted.current) return;
        const msg = e?.message || String(e);
        if (isCrawl) emitRunEvent({ phase: 'run', kind: 'error', level: 'error', detail: msg });
        setResult({ ok: false, error: msg });
      })
      .finally(() => {
        setLogSink(null);
        unsub();
        clearInterval(id);
        if (mounted.current) setStatus(getStatus());
      });
    return () => {
      mounted.current = false;
      setLogSink(null);
      unsub();
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- CRAWL: dashboard "mission control" ----
  if (isCrawl) {
    const elapsedMs = Date.now() - startAt.current;
    return html`<${Box} flexDirection="column">
      <${CrawlDashboard}
        status=${status}
        tele=${tele}
        feed=${feed}
        ticker=${ticker}
        warnCount=${warnCount}
        verbose=${verbose}
        rawLines=${lines}
        elapsedMs=${elapsedMs}
        result=${result}
      />
      ${result && !result.ok
        ? html`<${Box} marginTop=${1}><${Alert} variant="error">${result.error || t('failed')}</${Alert}></${Box}>`
        : null}
      ${result
        ? html`<${Box} marginTop=${1}><${Select}
            options=${[
              { label: t('backToMenu'), value: 'menu' },
              { label: t('quit'), value: 'quit' },
            ]}
            onChange=${onDone}
          /></${Box}>`
        : null}
    </${Box}>`;
  }

  // ---- Demais comandos: painel simples de sempre ----
  const f = status.frontier;
  const dArticles = Math.max(0, status.articles - baseline.articles);
  const dClassif = Math.max(0, status.classified - baseline.classified);
  const counters =
    spec.sub === 'search' && prog
      ? t('searchScanning', { n: prog.scanned, total: prog.total, m: prog.relevant })
      : `${t('articles')} +${dArticles} · ${t('classif')} +${dClassif} · ` +
        `${t('frontier')} ${f.pending}/${f.in_progress}/${f.done}/${f.failed}`;

  return html`<${Box} flexDirection="column">
    <${Box}>
      ${result
        ? html`<${Alert} variant=${result.ok ? 'success' : 'error'}>${
            result.ok ? t('done') : `${t('failed')}${result.error ? ': ' + result.error : ''}`
          }</${Alert}>`
        : html`<${Spinner} label=${`${t('running')} (${spec.sub})`} />`}
    </${Box}>
    <${Box} marginY=${1}><${Text} color="cyan">${counters}</${Text}></${Box}>
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
