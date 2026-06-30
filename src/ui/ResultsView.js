// Tela de RESULTADOS da busca (rolável). Usa SÓ useInput do ink (sem Select) — respeita a regra
// "um input por vez". Mostra 2 seções: Notícias e Ferramentas, com título_pt + resumo_pt.
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { html } from './html.js';
import { t } from './i18n.js';

const WINDOW = 14; // nº de "blocos" visíveis (cabeçalho = 1 bloco; item = 1 bloco de ~2 linhas)

export function ResultsView({ result, onDone }) {
  const r = result || { buckets: { noticias: [], ferramentas: [] } };
  const noticias = r.buckets?.noticias || [];
  const ferramentas = r.buckets?.ferramentas || [];
  const total = noticias.length + ferramentas.length;

  const blocks = [];
  const pushSection = (titleKey, items) => {
    blocks.push({ kind: 'header', text: `— ${t(titleKey)} (${items.length}) —` });
    for (const it of items) blocks.push({ kind: 'item', it });
  };
  pushSection('resultsNoticias', noticias);
  pushSection('resultsFerramentas', ferramentas);

  const [offset, setOffset] = useState(0);
  const maxOffset = Math.max(0, blocks.length - WINDOW);
  useInput((input, key) => {
    if (key.downArrow || input === 'j') setOffset((o) => Math.min(maxOffset, o + 1));
    else if (key.upArrow || input === 'k') setOffset((o) => Math.max(0, o - 1));
    else if (input === 'b') onDone('menu');
    else if (input === 'q') onDone('quit');
  });

  const header = `busca "${r.query || ''}" (modo ${r.mode || '?'})`;
  if (total === 0) {
    return html`<${Box} flexDirection="column">
      <${Text}>${header}</${Text}>
      <${Text} color="yellow">${r.needsClassification ? t('searchNoClass') : t('resultsNone')}</${Text}>
      <${Box} marginTop=${1}><${Text} dimColor>${t('resultsScroll')}</${Text}></${Box}>
    </${Box}>`;
  }

  const view = blocks.slice(offset, offset + WINDOW);
  return html`<${Box} flexDirection="column">
    <${Text}>${`${header} · ${r.relevant}/${r.total}`}</${Text}>
    <${Box} flexDirection="column" marginY=${1}>
      ${view.map((b, i) =>
        b.kind === 'header'
          ? html`<${Text} key=${i} bold color="magenta">${b.text}</${Text}>`
          : html`<${Box} key=${i} flexDirection="column">
              <${Text} wrap="truncate-end">
                <${Text} color="cyan">[${b.it.relation}]</${Text}> ${b.it.title_pt || b.it.title || ''}
              </${Text}>
              <${Text} dimColor wrap="truncate-end">  ${(b.it.summary_pt || b.it.snippet || '').slice(0, 160)}</${Text}>
            </${Box}>`,
      )}
    </${Box}>
    <${Text} dimColor>${t('resultsScroll')}</${Text}>
  </${Box}>`;
}
