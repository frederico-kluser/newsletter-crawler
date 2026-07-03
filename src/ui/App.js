// Raiz da UI: barra de status no topo + roteamento de telas. Monta o thunk do comando escolhido
// (a partir de commands.js) e entrega à RunView. Sem hotkeys globais — navega por Select/onChange.
import { useState, Fragment } from 'react';
import { Box, Text, useApp } from 'ink';
import { Badge, ThemeProvider } from '@inkjs/ui';
import { html } from './html.js';
import { t } from './i18n.js';
import { colors, space, uiTheme } from './theme.js';
import { Header } from './widgets.js';
import {
  getStatus, cmdCrawl, cmdExport, cmdClassify, cmdAdd, cmdReset, cmdSummarize, cmdFinish, cmdSearch,
  getArticle,
} from '../commands.js';
import { openBrowser } from '../web.js';
import {
  Menu, StatusScreen, CrawlConfig, ExportConfig, ClassifyConfig, AddConfig, ResetConfirm,
  SummarizeConfig, FinishConfig, SearchConfig, WebConfig, LimitsConfig,
} from './screens.js';
import { RunView } from './RunView.js';
import { ResultsView } from './ResultsView.js';

const THUNKS = {
  crawl: (flags) => cmdCrawl(flags),
  export: (flags) => cmdExport(flags),
  classify: (flags) => cmdClassify(flags),
  summarize: (flags) => cmdSummarize(flags),
  finish: (flags) => cmdFinish(flags),
  search: (flags, rest) => cmdSearch(rest, flags), // retorna os resultados p/ a UI
  add: (flags, rest) => cmdAdd(rest, flags),
  reset: (flags) => cmdReset(flags),
};

function StatusBar() {
  const s = getStatus();
  const f = s.frontier;
  const gap = html`<${Text}> </${Text}>`;
  // "Falta terminar", separando o que precisa de Coletar (na fila = ainda não baixado) do que
  // precisa de Finalizar (já salvo, sem tags/resumo). Cada badge só aparece quando > 0.
  const pend = [];
  if (f.pending > 0) pend.push([`${f.pending} ${t('queued')}`, colors.warn]);
  if (s.pendingClassif > 0) pend.push([`${s.pendingClassif} ${t('noTags')}`, colors.title]);
  if (s.pendingSummary > 0) pend.push([`${s.pendingSummary} ${t('noSummary')}`, colors.title]);
  return html`<${Box} flexDirection="column" marginBottom=${1}>
    <${Box}>
      <${Text} bold color=${colors.title}>${t('title')} </${Text}>
      <${Text} dimColor>${t('subtitle')}</${Text}>
    </${Box}>
    <${Box} marginTop=${1}>
      <${Badge} color=${colors.ok}>${`${s.articles} ${t('articles')}`}</${Badge}>${gap}
      <${Badge} color=${colors.link}>${`${s.sources} ${t('sources')}`}</${Badge}>${gap}
      <${Badge} color=${colors.accent}>${`${s.classified} ${t('classif')}`}</${Badge}>
    </${Box}>
    <${Box} marginTop=${1}>
      <${Text} bold>${t('pendingLabel')}: </${Text}>
      ${pend.length
        ? pend.map(([label, color], i) =>
            html`<${Fragment} key=${i}><${Badge} color=${color}>${label}</${Badge}>${gap}</${Fragment}>`)
        : html`<${Text} color=${colors.ok}>${t('allProcessed')}</${Text}>`}
    </${Box}>
  </${Box}>`;
}

export default function App() {
  const { exit } = useApp();
  const [screen, setScreen] = useState('menu');
  const [runSpec, setRunSpec] = useState(null);
  const [runResult, setRunResult] = useState(null); // resultados da busca
  const [, setRefresh] = useState(0);

  const onRun = ({ sub, flags = {}, rest = [] }) => {
    setRunSpec({ sub, flags, rest, thunk: () => THUNKS[sub](flags, rest) });
    setScreen('run');
  };
  const toMenu = () => {
    setRefresh((k) => k + 1); // força StatusBar a reler getStatus() após um run
    setScreen('menu');
  };

  let body = null;
  if (screen === 'menu') {
    body = html`<${Menu} onSelect=${(v) => (v === 'quit' ? exit() : setScreen(v))} />`;
  } else if (screen === 'status') {
    body = html`<${StatusScreen} status=${getStatus()} onBack=${toMenu} />`;
  } else if (screen === 'crawl') {
    body = html`<${CrawlConfig} onRun=${onRun} onBack=${toMenu} />`;
  } else if (screen === 'export') {
    body = html`<${ExportConfig} onRun=${onRun} onBack=${toMenu} />`;
  } else if (screen === 'classify') {
    body = html`<${ClassifyConfig} onRun=${onRun} onBack=${toMenu} />`;
  } else if (screen === 'summarize') {
    body = html`<${SummarizeConfig} onRun=${onRun} onBack=${toMenu} />`;
  } else if (screen === 'finish') {
    body = html`<${FinishConfig} onRun=${onRun} onBack=${toMenu} />`;
  } else if (screen === 'search') {
    body = html`<${SearchConfig} onRun=${onRun} onBack=${toMenu} />`;
  } else if (screen === 'web') {
    body = html`<${WebConfig} onBack=${toMenu} />`;
  } else if (screen === 'limits') {
    body = html`<${LimitsConfig} onBack=${toMenu} />`;
  } else if (screen === 'add') {
    body = html`<${AddConfig} onRun=${onRun} onBack=${toMenu} />`;
  } else if (screen === 'reset') {
    body = html`<${ResetConfirm} onRun=${onRun} onBack=${toMenu} />`;
  } else if (screen === 'run') {
    body = html`<${RunView}
      spec=${runSpec}
      onResults=${(data) => {
        setRunResult(data);
        setScreen('results');
      }}
      onDone=${(v) => (v === 'quit' ? exit() : toMenu())}
    />`;
  } else if (screen === 'results') {
    body = html`<${ResultsView}
      result=${runResult}
      onOpen=${openBrowser}
      getArticle=${getArticle}
      onDone=${(v) => (v === 'quit' ? exit() : toMenu())}
    />`;
  }

  return html`<${ThemeProvider} theme=${uiTheme}>
    <${Box} flexDirection="column" padding=${space.pad}>
      <${StatusBar} />
      <${Header} screen=${screen} />
      ${body}
    </${Box}>
  </${ThemeProvider}>`;
}
