// Painel de progresso AO VIVO. Captura os logs do comando via setLogSink (ring buffer, sem
// <Static> p/ não crescer/vazar) e poll das contagens a cada 300ms. O comando é I/O-bound, então
// o event loop fica livre p/ o render do Ink. Cleanup (unmount/Ctrl-C) remove o sink e o intervalo.
import { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { Spinner, Alert, Select } from '@inkjs/ui';
import { html } from './html.js';
import { t } from './i18n.js';
import { setLogSink } from '../util.js';
import { getStatus, getSearchProgress } from '../commands.js';

const LEVEL_COLOR = { warn: 'yellow', error: 'red', debug: 'gray' };
const VISIBLE = 12;

export function RunView({ spec, onDone, onResults }) {
  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState(() => getStatus());
  const [baseline] = useState(() => getStatus());
  const [result, setResult] = useState(null); // { ok, error }
  const [prog, setProg] = useState(null); // progresso da busca (modo A)
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
