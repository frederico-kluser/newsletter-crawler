// Raiz da UI: barra de status no topo + roteamento de telas. Monta o thunk do comando escolhido
// (a partir de commands.js) e entrega à RunView. Sem hotkeys globais — navega por Select/onChange.
import { useState, useMemo, Fragment } from 'react';
import { Box, Text, useApp } from 'ink';
import { Badge, ThemeProvider } from '@inkjs/ui';
import { html } from './html.js';
import { t } from './i18n.js';
import { colors, space, uiTheme } from './theme.js';
import { Header } from './widgets.js';
import { safeStatus } from './status.js';
import {
  cmdCrawl, cmdExport, cmdAdd, cmdReset, cmdFinish, cmdSearch,
  getArticle, listSearchHistory, getSearchHistoryEntry, deleteSearchHistory,
  listSourcesForUI, setSourceType, redetectSourceType, removeSourceById, resetSourceCursorById,
  deploySnapshot, checkResetConfirmation, backupBeforeDestructive,
} from '../commands.js';
import { cmdRestore, swapDatabaseFile } from '../cli-restore.js';
import { bestBackup, createBackup, latestBackup, listBackups, pruneBackups } from '../backup.js';
import { isGitRepo } from '../restore.js';
import { BACKUP_DIR, ROOT } from '../config.js';
import { warn } from '../util.js';
import { openBrowser } from '../web.js';
import {
  Menu, MaintenanceMenu, StatusScreen, CrawlConfig, ExportConfig, AddConfig, ResetConfirm,
  FinishConfig, SearchConfig, WebConfig, LimitsConfig, KeyConfig, DeployConfirm,
} from './screens.js';
import { RunView } from './RunView.js';
import { deployOutcome } from './runLines.js';
import { ResultsView } from './ResultsView.js';
import { HistoryView } from './HistoryView.js';
import { SourcesView } from './SourcesView.js';
import { BackupView } from './BackupView.js';
import { RestoreView } from './RestoreView.js';

const THUNKS = {
  crawl: (flags) => cmdCrawl(flags),
  export: (flags) => cmdExport(flags),
  finish: (flags) => cmdFinish(flags),
  // retorna os resultados p/ a UI; origem 'tui' marca o histórico de buscas
  search: (flags, rest) => cmdSearch(rest, { ...flags, origin: 'tui' }),
  add: (flags, rest) => cmdAdd(rest, flags),
  reset: (flags) => cmdReset(flags),
  // restore do histórico do git: as guardas de exit do cmdRestore (repo sem git, base viva sem
  // --yes) já foram pré-validadas na tela, como manda o padrão da TUI.
  restore: (flags) => cmdRestore(flags),
  // O deploy ABORTA em condições previsíveis (branch errada, remoto à frente): a mensagem já vem
  // pronta na DeployError, então virá um resultado 'error' em vez de estourar o painel genérico.
  deploy: async (flags) => {
    try {
      return await deploySnapshot(flags);
    } catch (e) {
      return { status: 'error', message: e?.message || String(e), hint: e?.hint || null };
    }
  },
};

// Desfecho customizado do Alert final, por comando (o resto cai no "Concluído ✓" genérico).
const OUTCOMES = { deploy: deployOutcome };

/**
 * Cópia manual do banco pela tela de Backups. Usa os MESMOS primitivos do `ncrawl backup`
 * (createBackup + pruneBackups, retenção sempre DEPOIS da cópia); o que fica de fora é só a casca
 * de CLI dele — os `process.exit(1)`, que sob o Ink derrubariam a sessão sem restaurar o terminal.
 * Retorna { ok, backup, reason:'created'|'empty'|'failed' }.
 */
function createBackupForUI() {
  const before = safeStatus();
  const hasData = before.articles > 0 || before.pages > 0 || before.sources > 0;
  if (!hasData) return { ok: true, backup: null, reason: 'empty' };
  const backup = createBackup({ reason: 'manual' });
  if (!backup) return { ok: false, backup: null, reason: 'failed' };
  try {
    pruneBackups();
  } catch (e) {
    warn(`backup: retenção falhou (${e.message}) — a cópia nova está a salvo.`);
  }
  return { ok: true, backup, reason: 'created' };
}

/**
 * Reposição a partir de um ARQUIVO de backup — a receita do `ncrawl backup restore`: backup do
 * banco VIVO primeiro (repor cópia velha não pode ser mais um jeito de perder o que estava vivo),
 * depois o swap (que fecha a conexão e mata os sidecars -wal/-shm). Aqui também reusamos os
 * primitivos em vez do cmdBackup: as falhas viram TELA, não `process.exit` no meio do render.
 * A conexão fica FECHADA depois disto — a tela que chama só oferece SAIR.
 */
function restoreBackupFileForUI(pick) {
  const guard = backupBeforeDestructive('pre-backup-restore');
  if (!guard.ok) return { ok: false, name: pick.name, error: 'backup do banco atual falhou' };
  const swap = swapDatabaseFile(pick.path);
  if (!swap.ok) return { ok: false, name: pick.name, error: swap.error };
  return { ok: true, name: pick.name, articles: pick.articles };
}

function StatusBar() {
  const s = safeStatus();
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
  const [searchInitial, setSearchInitial] = useState(null); // pré-preenchimento (re-rodar do histórico)
  const [, setRefresh] = useState(0);

  // Cada uma dessas três funções VARRE o diretório de backups e ABRE cada cópia p/ contar artigos:
  // caro demais p/ rodar a cada render. Memoiza por TELA (entrar na tela é o momento de reler).
  const backupInfo = useMemo(
    () =>
      screen === 'backup' || screen === 'restore'
        ? { list: listBackups(), latest: latestBackup(), best: bestBackup() }
        : { list: [], latest: null, best: null },
    [screen],
  );

  const onRun = ({ sub, flags = {}, rest = [] }) => {
    setRunSpec({ sub, flags, rest, thunk: () => THUNKS[sub](flags, rest), outcome: OUTCOMES[sub] });
    setScreen('run');
  };
  const toMenu = () => {
    setRefresh((k) => k + 1); // força StatusBar a reler getStatus() após um run
    setSearchInitial(null); // pré-preenchimento do re-rodar não vaza pra próxima busca do menu
    setScreen('menu');
  };

  let body = null;
  if (screen === 'menu') {
    body = html`<${Menu} onSelect=${(v) => {
      if (v === 'quit') return exit();
      setSearchInitial(null);
      setScreen(v);
    }} />`;
  } else if (screen === 'status') {
    body = html`<${StatusScreen} status=${safeStatus()} onBack=${toMenu} />`;
  } else if (screen === 'crawl') {
    body = html`<${CrawlConfig} onRun=${onRun} onBack=${toMenu} />`;
  } else if (screen === 'export') {
    body = html`<${ExportConfig} onRun=${onRun} onBack=${toMenu} />`;
  } else if (screen === 'finish') {
    body = html`<${FinishConfig} onRun=${onRun} onBack=${toMenu} />`;
  } else if (screen === 'search') {
    body = html`<${SearchConfig} onRun=${onRun} onBack=${toMenu} initial=${searchInitial} />`;
  } else if (screen === 'history') {
    // Histórico de buscas: abrir reabre o resultado CONGELADO na ResultsView (zero LLM);
    // re-rodar cai no fluxo de busca pré-preenchido (confirmação de custo usual).
    body = html`<${HistoryView}
      entries=${listSearchHistory()}
      onOpen=${(e) => {
        const r = getSearchHistoryEntry(e.id);
        if (!r) return;
        setRunResult(r);
        setScreen('results');
      }}
      onRerun=${(e) => {
        setSearchInitial({ query: e.query, mode: e.mode === 'B' ? 'B' : 'A', all: Boolean(e.scope?.all) });
        setScreen('search');
      }}
      onDelete=${(id) => deleteSearchHistory(id)}
      onClearAll=${() => deleteSearchHistory(null)}
      onDone=${(v) => (v === 'quit' ? exit() : toMenu())}
    />`;
  } else if (screen === 'web') {
    body = html`<${WebConfig} onBack=${toMenu} />`;
  } else if (screen === 'limits') {
    body = html`<${LimitsConfig} onBack=${toMenu} />`;
  } else if (screen === 'key') {
    body = html`<${KeyConfig} onBack=${toMenu} />`;
  } else if (screen === 'add') {
    body = html`<${AddConfig} onRun=${onRun} onBack=${toMenu} />`;
  } else if (screen === 'sources') {
    // Gerenciar fontes: trocar o tipo (síncrono), re-detectar por IA (assíncrono) e remover de vez.
    // `confirmCheck` é o MESMO desafio numérico do reset (checkResetConfirmation), aplicado à
    // contagem da fonte — remover uma fonte apaga o acervo dela inteiro.
    body = html`<${SourcesView}
      sources=${listSourcesForUI()}
      onToggleType=${(s, type) => setSourceType(s.id, type)}
      onRedetect=${(s) => redetectSourceType(s.id)}
      onRemove=${(s) => removeSourceById(s.id)}
      onResetCursor=${(s) => resetSourceCursorById(s.id)}
      confirmCheck=${(answer, n) => checkResetConfirmation(answer, { articles: n })}
      onDone=${(v) => (v === 'quit' ? exit() : toMenu())}
    />`;
  } else if (screen === 'maintenance') {
    // Backup / Recuperar / (só aqui) Limpar tudo — fora do fluxo principal e longe do "Sair".
    body = html`<${MaintenanceMenu} onSelect=${(v) => setScreen(v)} onBack=${toMenu} />`;
  } else if (screen === 'backup') {
    body = html`<${BackupView}
      backups=${backupInfo.list}
      dir=${BACKUP_DIR}
      onCreate=${createBackupForUI}
      onDone=${(v) => (v === 'quit' ? exit() : setScreen('maintenance'))}
    />`;
  } else if (screen === 'restore') {
    body = html`<${RestoreView}
      articles=${safeStatus().articles}
      backups=${backupInfo.list}
      latest=${backupInfo.latest}
      best=${backupInfo.best}
      dir=${BACKUP_DIR}
      root=${ROOT}
      hasGit=${isGitRepo(ROOT)}
      onRunGit=${(flags) => onRun({ sub: 'restore', flags })}
      onRestoreFile=${restoreBackupFileForUI}
      onDone=${(v) => (v === 'quit' ? exit() : setScreen('maintenance'))}
    />`;
  } else if (screen === 'reset') {
    body = html`<${ResetConfirm} onRun=${onRun} onBack=${() => setScreen('maintenance')} />`;
  } else if (screen === 'deploy') {
    body = html`<${DeployConfirm} onRun=${onRun} onBack=${toMenu} />`;
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
