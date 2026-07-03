// Widgets compartilhados da TUI (moldura, rodapé de atalhos, breadcrumb). Política de BORDA:
// só DUAS superfícies com borda no app — o overlay `v` (log bruto) e o card do comando
// equivalente no Review. Borda é SIGNIFICADO ("artefato copiável / detalhe bruto"), não decoração.
import { Box, Text } from 'ink';
import { html } from './html.js';
import { t } from './i18n.js';
import { colors, glyphs, space } from './theme.js';

export function Panel({ title, borderColor = colors.muted, children, ...boxProps }) {
  return html`<${Box} flexDirection="column" borderStyle="round" borderColor=${borderColor}
      paddingX=${space.panelPadX} ...${boxProps}>
    ${title ? html`<${Text} dimColor>${title}</${Text}>` : null}
    ${children}
  </${Box}>`;
}

// Rodapé de atalhos padronizado: pares {k, label} → "k label · k label". `inline` devolve só o
// <Text> (p/ compor na mesma linha após outro texto, ex.: o contador de avisos do dashboard).
export function FooterHints({ hints = [], inline = false }) {
  const text = hints.map(({ k, label }) => `${k} ${label}`).join(' · ');
  const node = html`<${Text} dimColor>${text}</${Text}>`;
  return inline ? node : html`<${Box} marginTop=${space.section}>${node}</${Box}>`;
}

// Breadcrumb de tela: "◆ <título do menu>". Telas fora do mapa (menu/run — o dashboard tem
// cabeçalho próprio) não pintam nada.
const HEADER_KEY = {
  crawl: 'menuCrawl',
  search: 'menuSearch',
  results: 'menuSearch',
  web: 'menuWeb',
  status: 'menuStatus',
  export: 'menuExport',
  classify: 'menuClassify',
  summarize: 'menuSummarize',
  finish: 'menuFinish',
  add: 'menuAdd',
  limits: 'menuLimits',
  reset: 'menuReset',
};
export function Header({ screen }) {
  const key = HEADER_KEY[screen];
  if (!key) return null;
  return html`<${Box} marginBottom=${space.section}>
    <${Text} bold color=${colors.title}>${glyphs.app} ${t(key)}</${Text}>
  </${Box}>`;
}
