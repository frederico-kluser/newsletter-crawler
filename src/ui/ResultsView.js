// Tela de RESULTADOS da busca: lista NAVEGÁVEL (seleção por item) + PREVIEW rolável na própria
// tela. Um ÚNICO useInput ramifica por modo (lista|preview) — regra "um input por vez" do repo.
// Componente 100% puro: DB e browser chegam por props (getArticle/onOpen), então testes injetam
// fakes. NÃO toca em setLogSink (nenhum comando roda aqui; a busca já terminou).
import { useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { html } from './html.js';
import { t } from './i18n.js';
import { colors, glyphs } from './theme.js';
import { FooterHints } from './widgets.js';
import { hostOf } from '../util.js';

const MAX_BODY_LINES = 5000; // teto p/ content patológico (o wrap é O(len), roda 1x por Enter)

/**
 * Quebra texto plano em linhas de até `width` colunas (greedy por palavra): \n\n+ = parágrafo
 * (vira linha em branco), \n simples vira espaço; palavra maior que a largura sofre corte duro.
 * Exportada p/ teste unitário direto.
 */
export function wrapPlainText(text, width) {
  const out = [];
  for (const para of String(text || '').replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const words = para.replace(/\s+/g, ' ').trim().split(' ');
    if (!words[0]) continue;
    let line = '';
    for (let w of words) {
      while (w.length > width) {
        if (line) {
          out.push(line);
          line = '';
        }
        out.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!line) line = w;
      else if (line.length + 1 + w.length <= width) line += ` ${w}`;
      else {
        out.push(line);
        line = w;
      }
    }
    if (line) out.push(line);
    out.push(''); // separador de parágrafo
  }
  if (out.at(-1) === '') out.pop();
  return out;
}

// Corpo da preview: resumo PT primeiro, depois o conteúdo completo (ou blurb/snippet).
function buildBodyLines(item, article, width) {
  const lines = [];
  if (item.summary_pt) lines.push(...wrapPlainText(item.summary_pt, width), '');
  const body = article?.content || article?.blurb || item.snippet || '';
  if (body) lines.push(...wrapPlainText(body, width));
  if (!lines.length) lines.push(t('previewNoContent'));
  if (lines.length > MAX_BODY_LINES) {
    lines.length = MAX_BODY_LINES;
    lines.push(t('previewTruncated', { n: MAX_BODY_LINES }));
  }
  return lines;
}

export function ResultsView({ result, onDone, onOpen, getArticle }) {
  const r = result || { buckets: { noticias: [], ferramentas: [] } };
  const noticias = r.buckets?.noticias || [];
  const ferramentas = r.buckets?.ferramentas || [];
  const nNot = noticias.length;

  // Lista plana selecionável; a seção vira anotação _sec (o modo B não tem kind por item).
  const items = useMemo(
    () => [
      ...noticias.map((it) => ({ ...it, _sec: 'news' })),
      ...ferramentas.map((it) => ({ ...it, _sec: 'tool' })),
    ],
    [result],
  );
  // Blocos renderizáveis: cabeçalhos (não selecionáveis) intercalados com os itens.
  const blocks = useMemo(() => {
    const out = [{ kind: 'header', text: `— ${t('resultsNoticias')} (${nNot}) —` }];
    items.slice(0, nNot).forEach((it, i) => out.push({ kind: 'item', it, idx: i }));
    out.push({ kind: 'header', text: `— ${t('resultsFerramentas')} (${items.length - nNot}) —` });
    items.slice(nNot).forEach((it, j) => out.push({ kind: 'item', it, idx: nNot + j }));
    return out;
  }, [items, nNot]);
  const blockOf = (i) => (i < nNot ? i + 1 : i + 2); // compensa os 2 cabeçalhos

  // Dimensões com clamps (ink-testing-library não tem rows -> fallbacks determinísticos).
  const { stdout } = useStdout();
  const cols = stdout?.columns || 80;
  const rows = stdout?.rows || 24;
  const textWidth = Math.max(20, cols - 6);
  const LIST_WINDOW = Math.max(6, Math.min(20, Math.floor((rows - 10) / 2))); // blocos (~2 linhas)
  const BODY_H = Math.max(5, rows - 16); // altura do corpo da preview

  const [nav, setNav] = useState({ selected: 0, offset: 0 }); // offset em BLOCOS
  const [preview, setPreview] = useState(null); // null | { item, article, lines, off }

  // Updaters funcionais e autocontidos: imunes a closure velha em rajadas de tecla.
  const move = (d) =>
    setNav(({ selected, offset }) => {
      const s = Math.min(items.length - 1, Math.max(0, selected + d));
      const b = blockOf(s);
      const top = blocks[b - 1]?.kind === 'header' ? b - 1 : b; // 1º da seção puxa o cabeçalho
      let o = offset;
      if (top < o) o = top;
      else if (b >= o + LIST_WINDOW) o = b - LIST_WINDOW + 1;
      o = Math.max(0, Math.min(o, Math.max(0, blocks.length - LIST_WINDOW)));
      return { selected: s, offset: o };
    });

  const openPreview = () => {
    const it = items[nav.selected];
    if (!it) return;
    let article = null;
    try {
      article = it.id != null ? (getArticle?.(it.id) ?? null) : null;
    } catch {
      article = null; // id sumiu (purge/reset noutro processo): preview cai nos dados da busca
    }
    setPreview({ item: it, article, lines: buildBodyLines(it, article, textWidth), off: 0 });
  };

  useInput((input, key) => {
    if (preview) {
      if (key.escape || input === 'b') return setPreview(null);
      if (input === 'q') return onDone('quit');
      if (input === 'o') {
        const url = preview.article?.url || preview.item?.url;
        if (url) onOpen?.(url);
        return;
      }
      const d = key.downArrow || input === 'j' ? 1
        : key.upArrow || input === 'k' ? -1
        : key.pageDown ? BODY_H
        : key.pageUp ? -BODY_H
        : 0;
      if (d) {
        setPreview((p) => {
          if (!p) return p;
          const max = Math.max(0, p.lines.length - BODY_H);
          return { ...p, off: Math.max(0, Math.min(max, p.off + d)) };
        });
      }
      return;
    }
    if (key.return) return openPreview();
    if (input === 'b') return onDone('menu');
    if (input === 'q') return onDone('quit');
    const d = key.downArrow || input === 'j' ? 1
      : key.upArrow || input === 'k' ? -1
      : key.pageDown ? LIST_WINDOW
      : key.pageUp ? -LIST_WINDOW
      : 0;
    if (d) move(d);
  });

  const header = `busca "${r.query || ''}" (modo ${r.mode || '?'})`;

  if (preview) {
    const { item, article, lines, off } = preview;
    const title = item.title_pt || item.title || item.url || '';
    const src = article?.source_name || item.source_name || hostOf(item.url || '') || '—';
    const date = item.date_iso || String(article?.extracted_at || '').slice(0, 10) || '—';
    const url = article?.url || item.url || '';
    const end = Math.min(off + BODY_H, lines.length);
    return html`<${Box} flexDirection="column">
      <${Text} bold wrap="wrap">${title}</${Text}>
      <${Text} dimColor>${`${t('previewSource')}: ${src} · ${t('previewDate')}: ${date}`}</${Text}>
      <${Text} color=${colors.accent}>${`[${item.relation}] · ${t(item._sec === 'tool' ? 'kindTool' : 'kindNews')}`}</${Text}>
      ${url
        ? html`<${Text} color=${colors.link} wrap="truncate-end">${url}</${Text}>`
        : html`<${Text} dimColor>${t('previewNoUrl')}</${Text}>`}
      ${!article && item.id != null
        ? html`<${Text} color=${colors.warn}>${t('previewMissing', { id: item.id })}</${Text}>`
        : null}
      <${Box} flexDirection="column" height=${BODY_H} marginY=${1}>
        ${lines.slice(off, end).map((ln, i) => html`<${Text} key=${off + i} wrap="truncate-end">${ln || ' '}</${Text}>`)}
      </${Box}>
      <${Box}>
        <${FooterHints} inline hints=${[
          { k: '↑/↓', label: t('hint_scroll') },
          { k: 'o', label: t('hint_openBrowser') },
          { k: 'Esc/b', label: t('hint_back') },
          { k: 'q', label: t('hint_quit') },
        ]} />
        <${Text} dimColor>${` · ${Math.min(off + 1, lines.length)}–${end}/${lines.length}`}</${Text}>
      </${Box}>
    </${Box}>`;
  }

  if (items.length === 0) {
    return html`<${Box} flexDirection="column">
      <${Text}>${header}</${Text}>
      <${Text} color=${colors.warn}>${r.needsClassification ? t('searchNoClass') : t('resultsNone')}</${Text}>
      <${FooterHints} hints=${[
        { k: 'b', label: t('hint_back') },
        { k: 'q', label: t('hint_quit') },
      ]} />
    </${Box}>`;
  }

  const view = blocks.slice(nav.offset, nav.offset + LIST_WINDOW);
  const skippedNote = r.skipped ? ` · ${r.skipped} ⏭` : '';
  // Resultado vindo do HISTÓRICO (congelado): anota quando foi salvo, custo real e itens que
  // saíram do acervo desde então. Buscas ao vivo não têm created_at → linha ausente.
  const frozenNote = r.created_at
    ? [
        t('histFrozen', { when: new Date(`${String(r.created_at).replace(' ', 'T')}Z`).toLocaleString() }),
        r.spent_usd > 0 ? `US$ ${r.spent_usd.toFixed(r.spent_usd < 0.01 ? 4 : 2)}` : null,
        r.missing > 0 ? t('histMissing', { n: r.missing }) : null,
      ].filter(Boolean).join(' · ')
    : null;
  return html`<${Box} flexDirection="column">
    <${Text}>${`${header} · ${r.relevant}/${r.total} · ${nav.selected + 1}/${items.length}${skippedNote}`}</${Text}>
    ${frozenNote ? html`<${Text} dimColor>${frozenNote}</${Text}>` : null}
    <${Box} flexDirection="column" marginY=${1}>
      ${view.map((b) => {
        if (b.kind === 'header') {
          return html`<${Text} key=${`h-${b.text}`} bold color=${colors.title}>${b.text}</${Text}>`;
        }
        const sel = b.idx === nav.selected;
        const meta = `${b.it.source_name || hostOf(b.it.url || '') || '—'} · ${b.it.date_iso || '—'}`;
        const resumo = (b.it.summary_pt || b.it.snippet || '').slice(0, 160);
        return html`<${Box} key=${b.it.id ?? `i${b.idx}`} flexDirection="column">
          ${sel
            ? html`<${Text} wrap="truncate-end" inverse>${`${glyphs.pointer} [${b.it.relation}] ${b.it.title_pt || b.it.title || ''}`}</${Text}>`
            : html`<${Text} wrap="truncate-end">${'  '}<${Text} color=${colors.accent}>[${b.it.relation}]</${Text}> ${b.it.title_pt || b.it.title || ''}</${Text}>`}
          <${Text} dimColor wrap="truncate-end">${`    ${meta} · ${resumo}`}</${Text}>
        </${Box}>`;
      })}
    </${Box}>
    <${FooterHints} inline hints=${[
      { k: 'Enter', label: t('hint_open') },
      { k: '↑/↓', label: t('hint_move') },
      { k: 'b', label: t('hint_back') },
      { k: 'q', label: t('hint_quit') },
    ]} />
  </${Box}>`;
}
