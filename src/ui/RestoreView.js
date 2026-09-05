// Tela "Recuperar acervo": as DUAS origens de recuperação, com a diferença entre elas dita em voz
// alta.
//   (1) HISTÓRICO DO GIT — o acervo versionado em webapp/public/data (`ncrawl restore`). É a
//       recuperação de "clone novo / banco perdido"; leva ~10s e é SÍNCRONA, então o aviso vem
//       ANTES: sem ele a tela parada parece travamento.
//   (2) ARQUIVO DE BACKUP — uma cópia do banco. Aqui `latestBackup()` e `bestBackup()` DIVERGEM:
//       a mais recente devolve o ESTADO ANTERIOR (inclusive um estado já encolhido) e a com mais
//       artigos devolve o ACERVO MAIS COMPLETO. Escolher errado é perder acervo de novo, então a
//       tela nomeia as duas e mostra a contagem de cada uma.
// Repor um arquivo FECHA a conexão do SQLite (receita do swapDatabaseFile) — por isso o desfecho
// dessa origem é uma tela terminal que só oferece SAIR.
import { useState } from 'react';
import { Box, Text } from 'ink';
import { Select, Alert, StatusMessage } from '@inkjs/ui';
import { html } from './html.js';
import { t } from './i18n.js';
import { colors } from './theme.js';
import { FooterHints } from './widgets.js';
import { fmtBytes, fmtWhen } from './BackupView.js';

const VISIBLE = 8;

export function RestoreView({
  articles = 0,
  backups = [],
  latest = null,
  best = null,
  dir = '',
  root = '',
  hasGit = true,
  onRunGit,
  onRestoreFile,
  onDone,
}) {
  const [step, setStep] = useState('origin'); // origin | git | list | confirm | done
  const [pick, setPick] = useState(null);
  const [result, setResult] = useState(null);

  // ---- desfecho da reposição por ARQUIVO: terminal, só sair ----
  if (step === 'done') {
    return html`<${Box} flexDirection="column">
      ${result?.ok
        ? html`<${StatusMessage} variant="success">${t('restoreDone', { name: result.name, n: result.articles ?? '?' })}</${StatusMessage}>`
        : html`<${Alert} variant="error">${t('restoreFailed', { msg: result?.error || '?' })}</${Alert}>`}
      <${Box} marginY=${1}><${Text} color=${colors.warn}>${t('restoreRestart')}</${Text}></${Box}>
      <${Select}
        options=${[{ label: t('restoreQuit'), value: 'quit' }]}
        onChange=${() => onDone?.('quit')}
      />
    </${Box}>`;
  }

  // ---- confirmação da cópia escolhida ----
  if (step === 'confirm' && pick) {
    return html`<${Box} flexDirection="column">
      <${Alert} variant="warning">${t('restoreFileConfirm', { name: pick.name, n: pick.articles ?? '?', cur: articles })}</${Alert}>
      <${Box} marginY=${1} flexDirection="column">
        <${Text} dimColor>${t('restoreFileNote')}</${Text}>
        <${Text} dimColor>${`ncrawl backup restore ${pick.name} --yes`}</${Text}>
      </${Box}>
      <${Select}
        options=${[
          { label: t('cancel'), value: 'cancel' },
          { label: t('restoreFileGo'), value: 'go' },
        ]}
        onChange=${(v) => {
          if (v !== 'go') return setStep('list');
          // Síncrono (cópia de arquivo + backup do banco atual): o Ink não repinta no meio.
          const res = onRestoreFile?.(pick) || { ok: false, error: 'onRestoreFile ausente' };
          setResult(res);
          setStep('done');
        }}
      />
    </${Box}>`;
  }

  // ---- escolha da cópia: latest e best PRIMEIRO, nomeados pelo que significam ----
  if (step === 'list') {
    if (!backups.length) {
      return html`<${Box} flexDirection="column">
        <${StatusMessage} variant="warning">${t('restoreNoBackups', { dir })}</${StatusMessage}>
        <${Select} options=${[{ label: t('back'), value: 'back' }]} onChange=${() => setStep('origin')} />
      </${Box}>`;
    }
    const same = latest && best && latest.name === best.name;
    const options = [];
    if (latest) options.push({ label: t('restoreLatest', { name: latest.name, n: latest.articles ?? '?' }), value: `n:${latest.name}` });
    if (best && !same) options.push({ label: t('restoreBest', { name: best.name, n: best.articles ?? '?' }), value: `n:${best.name}` });
    for (const b of backups.slice(0, VISIBLE)) {
      if (b.name === latest?.name || (!same && b.name === best?.name)) continue;
      options.push({
        label: `${b.name} — ${b.articles == null ? t('backupUnreadable') : `${b.articles} ${t('articles')}`} · ${fmtBytes(b.bytes)} · ${fmtWhen(b.mtime)}`,
        value: `n:${b.name}`,
      });
    }
    options.push({ label: t('back'), value: 'back' });
    return html`<${Box} flexDirection="column">
      <${Text} bold>${t('restorePickFile')}</${Text}>
      <${Text} dimColor>${same ? t('restoreSameNote') : t('restoreDiffNote')}</${Text}>
      <${Box} marginTop=${1}>
        <${Select}
          options=${options}
          visibleOptionCount=${Math.min(options.length, VISIBLE + 3)}
          onChange=${(v) => {
            if (v === 'back') return setStep('origin');
            const name = v.slice(2);
            const chosen = backups.find((b) => b.name === name);
            // Cópia ILEGÍVEL nunca vira reposição (o cmdBackup sairia com exit 1 e derrubaria a TUI).
            if (!chosen || chosen.articles == null) {
              setResult({ ok: false, error: t('backupUnreadable') });
              return setStep('done');
            }
            setPick(chosen);
            setStep('confirm');
          }}
        />
      </${Box}>
    </${Box}>`;
  }

  // ---- restauração pelo histórico do git ----
  if (step === 'git') {
    if (!hasGit) {
      return html`<${Box} flexDirection="column">
        <${Alert} variant="error">${t('restoreNoGit', { root })}</${Alert}>
        <${Select} options=${[{ label: t('back'), value: 'back' }]} onChange=${() => setStep('origin')} />
      </${Box}>`;
    }
    return html`<${Box} flexDirection="column">
      <${StatusMessage} variant="warning">${t('restoreSlowWarn')}</${StatusMessage}>
      ${articles > 0
        ? html`<${Box} marginTop=${1}><${Alert} variant="warning">${t('restoreLiveWarn', { n: articles })}</${Alert}></${Box}>`
        : null}
      <${Box} marginTop=${1}>
        <${Select}
          options=${[
            { label: t('restoreDry'), value: 'dry' },
            { label: t('restoreGo'), value: 'go' },
            { label: t('back'), value: 'back' },
          ]}
          onChange=${(v) => {
            if (v === 'back') return setStep('origin');
            onRunGit?.(v === 'dry' ? { 'dry-run': true } : { yes: true });
          }}
        />
      </${Box}>
    </${Box}>`;
  }

  // ---- origem ----
  return html`<${Box} flexDirection="column">
    <${Text} bold>${t('restoreOrigin')}</${Text}>
    <${Box} marginTop=${1}>
      <${Select}
        options=${[
          { label: t('restoreFromGit'), value: 'git' },
          { label: t('restoreFromFile'), value: 'file' },
          { label: t('back'), value: 'back' },
        ]}
        onChange=${(v) => {
          if (v === 'back') return onDone?.('menu');
          setStep(v === 'git' ? 'git' : 'list');
        }}
      />
    </${Box}>
    <${FooterHints} hints=${[{ k: 'Enter', label: t('hint_select') }, { k: '←', label: t('hint_back') }]} />
  </${Box}>`;
}
