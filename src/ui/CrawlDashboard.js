// Painel "mission control" do crawl: uma REGIÃO DE STATUS persistente (cabeçalho+badge+cronômetro,
// tabela de fases com barras, "agora", % por data, faixa de métricas) SEPARADA de um FEED curado de
// eventos e um rodapé. Tudo derivado do snapshot vivo (props) — o componente só pinta. Recebe dados
// por PROPS (testável sem DB/Ink real). UM único timer de animação (useSpinnerFrame) alimenta todos
// os glifos ativos; o RunView faz o poll de dados. Glifos carregam o estado (canal redundante p/ NO_COLOR).
import { Box, Text, useStdout } from 'ink';
import { Badge, ProgressBar } from '@inkjs/ui';
import { html } from './html.js';
import { t } from './i18n.js';
import { derivePhases, deriveBadge } from './crawlPhases.js';
import { telemetryLine, budgetStageLine, progressDateLine, nowStagesLine } from './runLines.js';
import { colors, glyphs } from './theme.js';
import { useSpinnerFrame } from './hooks.js';
import { Panel, FooterHints } from './widgets.js';

const clamp = (lo, x, hi) => Math.max(lo, Math.min(hi, x));

const STATE_COLOR = { done: colors.ok, active: colors.accent, idle: colors.muted, error: colors.err };
function stateGlyph(state, frame) {
  if (state === 'done') return glyphs.tick;
  if (state === 'error') return glyphs.cross;
  if (state === 'active') return frame;
  return glyphs.idle;
}

const BADGE = {
  preparando: { color: colors.link, key: 'badgePreparando' },
  coletando: { color: colors.accent, key: 'badgeColetando' },
  finalizando: { color: colors.warn, key: 'badgeFinalizando' },
  done: { color: colors.ok, key: 'done' },
  failed: { color: colors.err, key: 'failed' },
};

const KIND_ICON = {
  'phase-start': '▶',
  'phase-end': '■',
  'source-seed': '+',
  'source-done': '◆',
  'floor-hit': '✓',
  'issue-curated': '▤',
  'roundup-links': '▤',
  'kept-blurb': '≈',
  split: '⑂',
  timeout: '⏱',
  'run-summary': '★',
  error: '✗',
};
const LEVEL_COLOR = { info: undefined, success: colors.ok, warn: colors.warn, error: colors.err };
const RAW_COLOR = { warn: colors.warn, error: colors.err, debug: colors.muted };

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${p2(mm)}:${p2(ss)}` : `${p2(mm)}:${p2(ss)}`;
}
function fmtClock(at) {
  try {
    return new Date(at).toTimeString().slice(0, 8); // HH:MM:SS local
  } catch {
    return '--:--:--';
  }
}

function PhaseRow({ phase, frame, barWidth }) {
  const { key, state, value, counters } = phase;
  return html`<${Box}>
    <${Box} width=${2}><${Text} color=${STATE_COLOR[state]}>${stateGlyph(state, frame)}</${Text}></${Box}>
    <${Box} width=${13}>
      <${Text} bold=${state === 'active'} dimColor=${state === 'idle'}>${t('phase_' + key)}</${Text}>
    </${Box}>
    ${value == null || barWidth < 4
      ? html`<${Box} width=${barWidth}><${Text} dimColor>${value == null ? '' : '—'}</${Text}></${Box}>`
      : html`<${Box} width=${barWidth} marginRight=${1}><${ProgressBar} value=${value} /></${Box}>`}
    <${Box}><${Text} dimColor>${counters}</${Text}></${Box}>
  </${Box}>`;
}

function EventRow({ e, cols }) {
  const icon = KIND_ICON[e.kind] || '·';
  const head = `${icon} ${t('evk_' + e.kind)}`;
  const detail = (e.detail || '') + (e.count > 1 ? ` (×${e.count})` : '');
  const src = e.source ? ` [${String(e.source).slice(0, 14)}]` : '';
  const detW = clamp(8, cols - 9 - 20 - src.length - 1, 200);
  return html`<${Box}>
    <${Box} width=${9}><${Text} dimColor>${fmtClock(e.at)}</${Text}></${Box}>
    <${Box} width=${20}><${Text} color=${LEVEL_COLOR[e.level]} wrap="truncate-end">${head}</${Text}></${Box}>
    <${Box} width=${detW}><${Text} wrap="truncate-end">${detail}</${Text}></${Box}>
    ${src ? html`<${Box}><${Text} dimColor>${src}</${Text}></${Box}>` : null}
  </${Box}>`;
}

export function CrawlDashboard({ status, tele, feed = [], ticker = null, warnCount = 0, verbose = false, rawLines = [], elapsedMs = 0, result = null }) {
  const { stdout } = useStdout();
  const cols = clamp(40, stdout?.columns || 80, 200);
  const rows = clamp(10, stdout?.rows || 24, 200);
  const barWidth = clamp(6, cols - 54, 24);
  const tight = rows < 18; // terminal baixo: corta métricas/since e encolhe o feed
  const feedHeight = clamp(3, (tight ? rows - 12 : rows - 17), 10);

  // `result` (do RunView: null enquanto roda, {ok} ao fim) decide o estado global. NÃO derivamos
  // falha da presença de erros no feed — falhas de jobs isolados não reprovam uma run bem-sucedida.
  const running = !result;
  const phases = derivePhases(status, tele, { result });
  const badge = BADGE[deriveBadge(status, tele, { result })] || BADGE.preparando;
  const frame = useSpinnerFrame(running); // só anima enquanto a run está viva

  const nowLine = running ? nowStagesLine(tele) : null;
  const dateLine = progressDateLine(tele);
  const telLine = telemetryLine(tele);
  const stageLine = budgetStageLine(tele);

  const ruleLabel = t('eventsLabel');
  const ruleHead = `${glyphs.rule} ${ruleLabel} `;
  const rule = ruleHead + glyphs.rule.repeat(clamp(0, cols - ruleHead.length - 2, 200));

  return html`<${Box} flexDirection="column">
    <${Box}>
      <${Text} bold color=${colors.title}>${glyphs.app} ${t('crawlRunTitle')} </${Text}>
      <${Badge} color=${badge.color}>${t(badge.key)}</${Badge}>
      <${Text} dimColor> · ${glyphs.clock} ${fmtElapsed(elapsedMs)}</${Text}>
      ${running ? html`<${Text} color=${colors.accent}> ${frame}</${Text}>` : null}
    </${Box}>

    <${Box} flexDirection="column" marginTop=${1}>
      ${phases.map((p) => html`<${PhaseRow} key=${p.key} phase=${p} frame=${frame} barWidth=${barWidth} />`)}
    </${Box}>

    ${ticker
      ? html`<${Box} marginTop=${1}>
          <${Text} color=${colors.ok}>${glyphs.saved} ${t('savedLabel')}: </${Text}>
          <${Text} wrap="truncate-end">${ticker.detail || ''}</${Text}>
        </${Box}>`
      : null}
    ${nowLine ? html`<${Box}><${Text} color=${colors.ok}>${nowLine}</${Text}></${Box}>` : null}
    ${!tight && dateLine ? html`<${Box}><${Text} color=${colors.title}>${dateLine}</${Text}></${Box}>` : null}
    ${!tight && telLine ? html`<${Box}><${Text} dimColor>${telLine}</${Text}></${Box}>` : null}
    ${!tight && stageLine ? html`<${Box}><${Text} dimColor>${stageLine}</${Text}></${Box}>` : null}

    <${Box} marginTop=${1}><${Text} dimColor>${rule}</${Text}></${Box}>
    ${feed.length === 0
      ? html`<${Box}><${Text} dimColor>${t('eventsEmpty')}</${Text}></${Box}>`
      : html`<${Box} flexDirection="column" height=${feedHeight}>
          ${feed.slice(-feedHeight).map((e) => html`<${EventRow} key=${e.id} e=${e} cols=${cols} />`)}
        </${Box}>`}

    <${Box} marginTop=${1}>
      ${warnCount > 0
        ? html`<${Text} color=${colors.warn}>${glyphs.warn} ${warnCount} ${t('warnsInternal')} · </${Text}>`
        : null}
      <${FooterHints} inline hints=${[
        { k: 'v', label: t('hint_details') },
        { k: 'q', label: t('hint_quit') },
      ]} />
    </${Box}>

    ${verbose
      ? html`<${Panel} title=${t('verboseTitle')} marginTop=${1}>
          ${(rawLines.length ? rawLines.slice(-(feedHeight + 4)) : [{ level: 'log', text: t('verboseEmpty') }]).map(
            (l, i) => html`<${Text} key=${i} color=${RAW_COLOR[l.level]} wrap="truncate-end">${l.text}</${Text}>`,
          )}
        </${Panel}>`
      : null}
  </${Box}>`;
}
