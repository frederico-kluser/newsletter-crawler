// Tela "Backups do acervo": cria uma cópia agora e LISTA as existentes com nº de ARTIGOS, tamanho
// e data. O número de artigos é o que torna a escolha auditável — sem ele, "backup-2026-09-01" e
// "backup-2026-08-25" são dois nomes iguais e o usuário não tem como saber qual guarda o acervo.
// Componente PURO: a lista e o `onCreate` chegam por props (os testes injetam spies sem DB).
import { useState } from 'react';
import { Box, Text } from 'ink';
import { Select, StatusMessage } from '@inkjs/ui';
import { html } from './html.js';
import { t } from './i18n.js';
import { colors } from './theme.js';
import { FooterHints } from './widgets.js';

const VISIBLE = 8; // a retenção padrão guarda 10 cópias; mostrar 8 + "e mais N" cabe em tela

/** Tamanho legível. Só apresentação (a decisão de reter/apagar vive no src/backup.js). */
export function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  return n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Data curta e ordenável (o ISO inteiro estoura a linha em terminal estreito). */
export function fmtWhen(d) {
  try {
    return new Date(d).toISOString().slice(0, 16).replace('T', ' ');
  } catch {
    return '?';
  }
}

export function BackupView({ backups = [], dir = '', onCreate, onDone }) {
  const [items, setItems] = useState(backups);
  const [note, setNote] = useState(null);
  const [variant, setVariant] = useState('success');
  // `round` REMONTA o Select a cada ação (key=${round}). Esta é a única tela do app onde o Select
  // SOBREVIVE ao próprio onChange (as outras trocam de step/tela e o desmontam) — e o @inkjs/ui
  // redispara o efeito do onChange sempre que `options`/`onChange` mudam de IDENTIDADE
  // (use-select-state.js: deps [previousValue, value, options, onChange]). Com o valor já
  // selecionado, o primeiro setState viraria um LOOP INFINITO de onChange; remontar zera o valor.
  const [round, setRound] = useState(0);

  const create = () => {
    setRound((n) => n + 1);
    // `onCreate` é SÍNCRONO (VACUUM INTO): a tela congela por um instante numa base grande — por
    // isso o aviso fica no rodapé ANTES do clique, não num spinner que não teria como girar.
    const res = onCreate?.() || { ok: false, reason: 'failed' };
    if (res.backup) {
      setItems((list) => [res.backup, ...list]);
      setVariant('success');
      setNote(t('backupCreated', { name: res.backup.name, n: res.backup.articles ?? '?' }));
      return;
    }
    setVariant(res.reason === 'empty' ? 'info' : 'error');
    setNote(res.reason === 'empty' ? t('backupNothing') : t('backupFailed', { dir }));
  };

  const view = items.slice(0, VISIBLE);
  return html`<${Box} flexDirection="column">
    ${note ? html`<${StatusMessage} variant=${variant}>${note}</${StatusMessage}>` : null}
    <${Box} flexDirection="column" marginY=${1}>
      <${Text} bold>${items.length ? t('backupCount', { n: items.length, dir }) : t('backupEmpty', { dir })}</${Text}>
      ${view.map((b) => html`<${Box} key=${b.name}>
        <${Text} wrap="truncate-end">${`  ${b.name}  `}</${Text}>
        <${Text} color=${b.articles == null ? colors.err : colors.accent}>
          ${b.articles == null ? t('backupUnreadable') : `${b.articles} ${t('articles')}`}
        </${Text}>
        <${Text} dimColor>${`  ${fmtBytes(b.bytes)}  ${fmtWhen(b.mtime)}  (${b.reason || '?'})`}</${Text}>
      </${Box}>`)}
      ${items.length > VISIBLE
        ? html`<${Text} dimColor>${`  ${t('backupMore', { n: items.length - VISIBLE })}`}</${Text}>`
        : null}
    </${Box}>
    <${Select}
      key=${round}
      options=${[
        { label: t('backupCreate'), value: 'create' },
        { label: t('back'), value: 'back' },
      ]}
      onChange=${(v) => (v === 'create' ? create() : onDone?.('menu'))}
    />
    <${FooterHints} hints=${[{ k: 'Enter', label: t('hint_select') }, { k: '←', label: t('hint_back') }]} />
  </${Box}>`;
}
