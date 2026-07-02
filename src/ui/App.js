// Raiz da UI: barra de status no topo + roteamento de telas. Monta o thunk do comando escolhido
// (a partir de commands.js) e entrega à RunView. Sem hotkeys globais — navega por Select/onChange.
import { useState } from 'react';
import { Box, Text, useApp } from 'ink';
import { Badge } from '@inkjs/ui';
import { html } from './html.js';
import { t } from './i18n.js';
import {
  getStatus, cmdCrawl, cmdExport, cmdClassify, cmdAdd, cmdReset, cmdSummarize, cmdSearch,
} from '../commands.js';
import {
  Menu, StatusScreen, CrawlConfig, ExportConfig, ClassifyConfig, AddConfig, ResetConfirm,
  SummarizeConfig, SearchConfig, WebConfig, LimitsConfig,
} from './screens.js';
import { RunView } from './RunView.js';
import { ResultsView } from './ResultsView.js';

const THUNKS = {
  crawl: (flags) => cmdCrawl(flags),
  export: (flags) => cmdExport(flags),
  classify: (flags) => cmdClassify(flags),
  summarize: (flags) => cmdSummarize(flags),
  search: (flags, rest) => cmdSearch(rest, flags), // retorna os resultados p/ a UI
  add: (flags, rest) => cmdAdd(rest, flags),
  reset: (flags) => cmdReset(flags),
};

function StatusBar() {
  const s = getStatus();
  const f = s.frontier;
  const gap = html`<${Text}> </${Text}>`;
  return html`<${Box} flexDirection="column" marginBottom=${1}>
    <${Box}>
      <${Text} bold color="magenta">${t('title')} </${Text}>
      <${Text} dimColor>${t('subtitle')}</${Text}>
    </${Box}>
    <${Box} marginTop=${1}>
      <${Badge} color="green">${`${s.articles} ${t('articles')}`}</${Badge}>${gap}
      <${Badge} color="blue">${`${s.sources} ${t('sources')}`}</${Badge}>${gap}
      <${Badge} color="yellow">${`${f.pending} ${t('frontier')}`}</${Badge}>${gap}
      <${Badge} color="cyan">${`${s.classified} ${t('classif')}`}</${Badge}>
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
      onDone=${(v) => (v === 'quit' ? exit() : toMenu())}
    />`;
  }

  return html`<${Box} flexDirection="column" padding=${1}>
    <${StatusBar} />
    ${body}
  </${Box}>`;
}
