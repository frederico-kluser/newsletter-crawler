// Tela "Gerenciar fontes": lista navegável das fontes cadastradas com o TIPO detectado, e ações
// pra AJUDAR na decisão do tipo (trocar/re-detectar) + REMOVER a fonte de vez. Um ÚNICO useInput
// ramificando por modo (list | armed | confirm | busy). Puro: dados e efeitos chegam por props
// (onToggleType/onRedetect síncr./assíncr., onRemove, confirmCheck) — os testes injetam spies sem DB.
//
// REMOVER apaga MILHARES de artigos (e o dinheiro de LLM que os produziu). `r` `r` era fricção de
// menos para isso: agora `r` abre uma confirmação DIGITADA (o número de artigos da fonte, o mesmo
// desafio do reset) e só a fonte SEM artigo nenhum segue no Enter seco — não há o que perder nela.
// Enquanto o campo está montado o useInput fica INATIVO (`isActive`), senão as letras digitadas
// disparariam os atalhos d/r/q da lista.
import { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { TextInput, Alert } from '@inkjs/ui';
import { html } from './html.js';
import { t } from './i18n.js';
import { colors, glyphs } from './theme.js';
import { FooterHints } from './widgets.js';

const typeColor = (type) => (type === 'index' ? colors.title : colors.link);

// Fallback do desafio numérico quando o App não injeta o cheque (montagem direta em teste): mesma
// regra do checkResetConfirmation — separador de milhar/espaço é aceito, o resto tem que bater.
const defaultConfirmCheck = (answer, expected) => {
  const given = String(answer ?? '').trim();
  return { ok: given.replace(/[.\s_,]/g, '') === String(expected), given, expected: String(expected) };
};

export function SourcesView({ sources: initial, onToggleType, onRedetect, onRemove, onDone, confirmCheck }) {
  const [items, setItems] = useState(initial || []);
  const [nav, setNav] = useState({ selected: 0, offset: 0 });
  const [mode, setMode] = useState('list'); // list | armed (0 artigos) | confirm (digitado) | busy
  const [note, setNote] = useState(null);
  const [err, setErr] = useState(null);
  // `tries` entra na `key` do campo: tentativa errada REMONTA o TextInput (uncontrolled) vazio,
  // senão o texto recusado fica no buffer e a 2ª tentativa vira "r3249".
  const [tries, setTries] = useState(0);

  const { stdout } = useStdout();
  const rows = stdout?.rows || 24; // ink-testing-library não tem rows
  const WINDOW = Math.max(4, Math.min(14, Math.floor((rows - 10) / 2)));

  const cur = items[nav.selected] || null;

  const move = (d) =>
    setNav(({ selected, offset }) => {
      const s = Math.min(Math.max(0, items.length - 1), Math.max(0, selected + d));
      let o = offset;
      if (s < o) o = s;
      else if (s >= o + WINDOW) o = s - WINDOW + 1;
      return { selected: s, offset: Math.max(0, Math.min(o, Math.max(0, items.length - WINDOW))) };
    });

  const patchType = (id, type) =>
    setItems((list) => list.map((x) => (x.id === id ? { ...x, type } : x)));

  // Remoção de verdade (síncrona, removeSourceById faz o backup por baixo). Compartilhada pelos
  // dois caminhos de confirmação: o digitado (fonte com artigos) e o Enter seco (fonte vazia).
  const doRemove = (s) => {
    const res = onRemove(s);
    const next = items.filter((x) => x.id !== s.id);
    setItems(next);
    setNav(({ selected, offset }) => ({
      selected: Math.max(0, Math.min(selected, next.length - 1)),
      offset: Math.max(0, Math.min(offset, Math.max(0, next.length - WINDOW))),
    }));
    setNote(t('srcRemoved', { name: s.name || s.base_url, n: res?.counts?.articles ?? 0 }));
    setErr(null);
    setMode('list');
  };

  useInput((input, key) => {
    if (mode === 'busy') return; // ação em andamento: ignora teclas até resolver

    if (mode === 'armed') {
      // Só fonte SEM artigo nenhum chega aqui: Enter/r confirma, qualquer outra tecla cancela.
      if (input === 'r' || input === 'y' || key.return) {
        if (!cur) return setMode('list');
        return doRemove(cur);
      }
      setMode('list');
      setNote(null);
      return;
    }

    // ---- modo list ----
    if (input === 'q') return onDone('quit');
    if (key.escape || input === 'b') return onDone('menu');
    if (!items.length) return;

    if (key.return) {
      // troca o tipo (index <-> listing)
      const s = cur;
      if (!s) return;
      const next = s.type === 'index' ? 'listing' : 'index';
      const res = onToggleType(s, next);
      const applied = res?.source?.type || next;
      patchType(s.id, applied);
      setNote(t('srcTypeChanged', { type: applied }));
      return;
    }

    if (input === 'd') {
      const s = cur;
      if (!s) return;
      setMode('busy');
      setNote(t('srcDetecting'));
      Promise.resolve(onRedetect(s))
        .then((res) => {
          const type = res?.source?.type || res?.detection?.type;
          if (type) patchType(s.id, type);
          setNote(t('srcRedetected', { type: type || s.type, reason: res?.detection?.reason || '' }));
        })
        .catch((e) => setNote(t('srcRedetectFail', { msg: e.message })))
        .finally(() => setMode('list'));
      return;
    }

    if (input === 'r') {
      if (!cur) return;
      setErr(null);
      // Fonte com acervo => desafio DIGITADO; fonte vazia => confirmação seca (nada a perder).
      setMode((cur.articles ?? 0) > 0 ? 'confirm' : 'armed');
      return;
    }

    const d = key.downArrow || input === 'j' ? 1
      : key.upArrow || input === 'k' ? -1
      : key.pageDown ? WINDOW
      : key.pageUp ? -WINDOW
      : 0;
    if (d) {
      setNote(null);
      move(d);
    }
  }, { isActive: mode !== 'confirm' }); // campo montado: o TextInput é dono do teclado

  // ---- confirmação DIGITADA da remoção (fonte com artigos) ----
  if (mode === 'confirm' && cur) {
    const n = cur.articles ?? 0;
    const check = confirmCheck || defaultConfirmCheck;
    return html`<${Box} flexDirection="column">
      <${Text} color=${colors.err}>${t('srcRemoveTypePrompt', { name: cur.name || cur.base_url, n })}</${Text}>
      <${Text} dimColor>${`${t('resetTypeHint')} ${t('srcRemoveBackupNote')}`}</${Text}>
      ${err ? html`<${Alert} variant="error">${err}</${Alert}>` : null}
      <${TextInput} key=${`src-remove-${tries}`} placeholder=${String(n)} onSubmit=${(val) => {
        const raw = String(val).trim();
        if (!raw) { // vazio = desistir
          setErr(null);
          setNote(null);
          return setMode('list');
        }
        const res = check(raw, n);
        if (!res.ok) {
          setTries((x) => x + 1); // remonta o campo vazio p/ a próxima tentativa
          return setErr(t('srcRemoveMismatch', { given: res.given ?? raw, expected: res.expected ?? n }));
        }
        doRemove(cur);
      }} />
    </${Box}>`;
  }

  if (!items.length) {
    return html`<${Box} flexDirection="column">
      <${Text} color=${colors.warn}>${t('srcEmpty')}</${Text}>
      <${FooterHints} hints=${[
        { k: 'Esc/b', label: t('hint_back') },
        { k: 'q', label: t('hint_quit') },
      ]} />
    </${Box}>`;
  }

  const view = items.slice(nav.offset, nav.offset + WINDOW);
  return html`<${Box} flexDirection="column">
    <${Text}>${`${items.length} ${t('srcCount')} · ${nav.selected + 1}/${items.length}`}</${Text}>
    ${note ? html`<${Text} color=${colors.accent}>${note}</${Text}>` : null}
    ${mode === 'armed' && cur
      ? html`<${Text} color=${colors.err}>${t('srcRemoveEmptyArm', { name: cur.name || cur.base_url })}</${Text}>`
      : null}
    <${Box} flexDirection="column" marginY=${1}>
      ${view.map((s, i) => {
        const idx = nav.offset + i;
        const sel = idx === nav.selected;
        const label = s.name || s.base_url;
        const meta = `    ${s.base_url} · ${s.articles ?? 0} ${t('articles')}`;
        return html`<${Box} key=${s.id} flexDirection="column">
          <${Box}>
            <${Text} wrap="truncate-end" inverse=${sel}>
              ${sel ? glyphs.pointer : '  '}${' '}${label}${' '}
            </${Text}>
            <${Text} color=${typeColor(s.type)}>${`[${s.type || 'listing'}]`}</${Text}>
          </${Box}>
          <${Text} dimColor wrap="truncate-end">${meta}</${Text}>
        </${Box}>`;
      })}
    </${Box}>
    <${FooterHints} inline hints=${[
      { k: 'Enter', label: t('hint_toggleType') },
      { k: 'd', label: t('hint_redetect') },
      { k: 'r', label: t('hint_removeSource') },
      { k: 'Esc/b', label: t('hint_back') },
      { k: 'q', label: t('hint_quit') },
    ]} />
  </${Box}>`;
}
