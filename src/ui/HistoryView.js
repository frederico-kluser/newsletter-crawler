// Tela do HISTÓRICO de buscas: lista navegável das buscas salvas (tabela `searches`) com abrir
// (resultado congelado — zero LLM), re-rodar (volta ao fluxo de busca, com a confirmação de custo
// usual) e apagar (item, ou tudo com 2º toque). Um ÚNICO useInput; sem TextInput montado → teclas
// de letra são seguras (mesma regra da ResultsView). Puro: dados e efeitos chegam por props.
import { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { html } from './html.js';
import { t } from './i18n.js';
import { colors, glyphs } from './theme.js';
import { FooterHints } from './widgets.js';

// created_at do SQLite (datetime('now')) é UTC 'YYYY-MM-DD HH:MM:SS' — exibe no fuso local.
export const fmtWhen = (sq) => {
  if (!sq) return '—';
  const d = new Date(`${String(sq).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? String(sq) : d.toLocaleString();
};

export function HistoryView({ entries: initial, onOpen, onRerun, onDelete, onClearAll, onDone }) {
  const [entries, setEntries] = useState(initial || []);
  const [nav, setNav] = useState({ selected: 0, offset: 0 });
  const [armClear, setArmClear] = useState(false); // 'x' arma; 2º 'x' apaga tudo

  const { stdout } = useStdout();
  const rows = stdout?.rows || 24; // ink-testing-library não tem rows
  const WINDOW = Math.max(4, Math.min(12, Math.floor((rows - 10) / 2))); // ~2 linhas por item

  const move = (d) =>
    setNav(({ selected, offset }) => {
      const s = Math.min(Math.max(0, entries.length - 1), Math.max(0, selected + d));
      let o = offset;
      if (s < o) o = s;
      else if (s >= o + WINDOW) o = s - WINDOW + 1;
      return { selected: s, offset: Math.max(0, Math.min(o, Math.max(0, entries.length - WINDOW))) };
    });

  useInput((input, key) => {
    if (input === 'q') return onDone('quit');
    if (key.escape || input === 'b') return onDone('menu');
    if (!entries.length) return;
    if (key.return) return onOpen(entries[nav.selected]);
    if (input === 'r') return onRerun(entries[nav.selected]);
    if (input === 'd') {
      const e = entries[nav.selected];
      if (!e) return;
      onDelete(e.id);
      const next = entries.filter((x) => x.id !== e.id);
      setEntries(next);
      setNav(({ selected, offset }) => ({
        selected: Math.max(0, Math.min(selected, next.length - 1)),
        offset: Math.max(0, Math.min(offset, Math.max(0, next.length - WINDOW))),
      }));
      setArmClear(false);
      return;
    }
    if (input === 'x') {
      if (!armClear) return setArmClear(true);
      onClearAll();
      setEntries([]);
      setArmClear(false);
      return;
    }
    const d = key.downArrow || input === 'j' ? 1
      : key.upArrow || input === 'k' ? -1
      : key.pageDown ? WINDOW
      : key.pageUp ? -WINDOW
      : 0;
    if (d) {
      setArmClear(false);
      move(d);
    }
  });

  if (!entries.length) {
    return html`<${Box} flexDirection="column">
      <${Text} color=${colors.warn}>${t('histEmpty')}</${Text}>
      <${FooterHints} hints=${[
        { k: 'Esc/b', label: t('hint_back') },
        { k: 'q', label: t('hint_quit') },
      ]} />
    </${Box}>`;
  }

  const view = entries.slice(nav.offset, nav.offset + WINDOW);
  return html`<${Box} flexDirection="column">
    <${Text}>${`${entries.length} ${t('histCount')} · ${nav.selected + 1}/${entries.length}`}</${Text}>
    ${armClear ? html`<${Text} color=${colors.err}>${t('histClearArm')}</${Text}>` : null}
    <${Box} flexDirection="column" marginY=${1}>
      ${view.map((e, i) => {
        const idx = nav.offset + i;
        const sel = idx === nav.selected;
        const usd = e.spent_usd > 0 ? ` · US$ ${e.spent_usd.toFixed(e.spent_usd < 0.01 ? 4 : 2)}` : '';
        const stats = `${e.stats?.relevant ?? '—'}/${e.stats?.total ?? '—'}`;
        const meta = `    ${fmtWhen(e.created_at)} · ${e.origin || '—'} · ${stats}${usd}`;
        return html`<${Box} key=${e.id} flexDirection="column">
          ${sel
            ? html`<${Text} wrap="truncate-end" inverse>${`${glyphs.pointer} "${e.query}" (${e.mode})`}</${Text}>`
            : html`<${Text} wrap="truncate-end">${'  '}"${e.query}" <${Text} color=${colors.accent}>(${e.mode})</${Text}></${Text}>`}
          <${Text} dimColor wrap="truncate-end">${meta}</${Text}>
        </${Box}>`;
      })}
    </${Box}>
    <${FooterHints} inline hints=${[
      { k: 'Enter', label: t('hint_open') },
      { k: 'r', label: t('hint_rerun') },
      { k: 'd', label: t('hint_delete') },
      { k: 'x', label: t('hint_clearAll') },
      { k: 'Esc/b', label: t('hint_back') },
    ]} />
  </${Box}>`;
}
