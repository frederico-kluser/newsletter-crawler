// Telas do menu guiado. Regra de foco: o Select/TextInput do @inkjs/ui capturam input enquanto
// montados, então renderizamos UM input por vez (wizard por `step`). onRun emite {sub,flags,rest};
// o App monta o thunk (a partir de commands.js) e troca p/ a RunView.
import { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { Select, TextInput, Alert, StatusMessage, Spinner } from '@inkjs/ui';
import { html } from './html.js';
import { t } from './i18n.js';
import { buildCommandPreview } from './commandPreview.js';
import { loadSources, HAS_LLM, BUDGET_USD, MAX_PARALLEL, RAM_MAX_PCT, ENV_PATH } from '../config.js';
import { upsertEnvVar } from '../keys.js';
import { parseDate } from '../util.js';
import { getStatus } from '../commands.js';
import { startWebServer, openBrowser } from '../web.js';

const yesNo = () => [
  { label: t('yes'), value: 'yes' },
  { label: t('no'), value: 'no' },
];
const parseIntFlag = (val) => {
  const v = String(val).trim();
  if (!v) return { ok: true, value: null }; // vazio = sem limite
  if (!/^\d+$/.test(v) || Number(v) <= 0) return { ok: false };
  return { ok: true, value: v };
};

// Tela de revisão reusável: mostra o comando equivalente e confirma.
function Review({ sub, flags, rest = [], onRun, onBack }) {
  return html`<${Box} flexDirection="column">
    <${Text} bold>${t('review')}</${Text}>
    <${Box} marginY=${1}><${Text} color="cyan">${buildCommandPreview(sub, flags, rest)}</${Text}></${Box}>
    <${Select}
      options=${[
        { label: t('runIt'), value: 'run' },
        { label: t('back'), value: 'back' },
      ]}
      onChange=${(v) => (v === 'run' ? onRun({ sub, flags, rest }) : onBack())}
    />
  </${Box}>`;
}

function Field({ label, error, children }) {
  return html`<${Box} flexDirection="column">
    <${Text} bold>${label}</${Text}>
    ${error ? html`<${Alert} variant="error">${error}</${Alert}>` : null}
    ${children}
  </${Box}>`;
}

export function Menu({ onSelect }) {
  const options = [
    { label: t('menuCrawl'), value: 'crawl' },
    { label: t('menuSearch'), value: 'search' },
    { label: t('menuWeb'), value: 'web' },
    { label: t('menuStatus'), value: 'status' },
    { label: t('menuExport'), value: 'export' },
    { label: t('menuClassify'), value: 'classify' },
    { label: t('menuSummarize'), value: 'summarize' },
    { label: t('menuAdd'), value: 'add' },
    { label: t('menuLimits'), value: 'limits' },
    { label: t('menuReset'), value: 'reset' },
    { label: t('menuQuit'), value: 'quit' },
  ];
  return html`<${Box} flexDirection="column">
    <${Select} options=${options} onChange=${onSelect} visibleOptionCount=${10} />
    <${Box} marginTop=${1}><${Text} dimColor>${t('hintNav')}</${Text}></${Box}>
  </${Box}>`;
}

export function StatusScreen({ status, onBack }) {
  const f = status.frontier;
  const row = (k, v) => html`<${Text}>${k.padEnd(11)} <${Text} color="cyan">${v}</${Text}></${Text}>`;
  return html`<${Box} flexDirection="column">
    <${Text} bold>${t('statusTitle')}</${Text}>
    <${Box} flexDirection="column" marginY=${1}>
      ${row(`${t('sources')}:`, status.sources)}
      ${row(`${t('pages')}:`, status.pages)}
      ${row(`${t('articles')}:`, status.articles)}
      ${row(`${t('selectors')}:`, status.selectors)}
      ${row(`${t('classif')}:`, `done=${status.classified} pending=${status.pendingClassif}`)}
      ${row(`${t('frontier')}:`, `pending=${f.pending} in_progress=${f.in_progress} done=${f.done} failed=${f.failed}`)}
    </${Box}>
    <${Select} options=${[{ label: t('back'), value: 'back' }]} onChange=${onBack} />
  </${Box}>`;
}

export function CrawlConfig({ onRun, onBack }) {
  const sources = loadSources();
  const [step, setStep] = useState('source');
  const [flags, setFlags] = useState({});
  const [err, setErr] = useState(null);
  const set = (patch) => setFlags((f) => ({ ...f, ...patch }));

  if (step === 'source') {
    const options = [
      { label: t('sourceAll'), value: '__all__' },
      ...sources.map((s) => ({ label: s.name || s.url, value: s.name || s.url })),
      { label: t('back'), value: '__back__' },
    ];
    return html`<${Box} flexDirection="column">
      ${sources.length === 0 ? html`<${StatusMessage} variant="warning">${t('noSources')}</${StatusMessage}>` : null}
      <${Text} bold>${t('pickSource')}</${Text}>
      <${Select} options=${options} onChange=${(v) => {
        if (v === '__back__') return onBack();
        if (v !== '__all__') set({ source: v });
        setStep('since');
      }} />
    </${Box}>`;
  }
  if (step === 'since') {
    return html`<${Field} label=${t('sincePrompt')} error=${err}>
      <${TextInput} key=${step} placeholder="2026-06-25" onSubmit=${(val) => {
        const v = val.trim();
        if (v && !parseDate(v)) return setErr(t('sinceInvalid'));
        setErr(null);
        if (v) set({ since: v });
        setStep('maxpages');
      }} />
    </${Field}>`;
  }
  if (step === 'maxpages') {
    return html`<${Field} label=${t('maxPagesPrompt')} error=${err}>
      <${TextInput} key=${step} placeholder="" onSubmit=${(val) => {
        const r = parseIntFlag(val);
        if (!r.ok) return setErr(t('numInvalid'));
        setErr(null);
        if (r.value) set({ 'max-pages': r.value });
        setStep('maxarticles');
      }} />
    </${Field}>`;
  }
  if (step === 'maxarticles') {
    return html`<${Field} label=${t('maxArticlesPrompt')} error=${err}>
      <${TextInput} key=${step} placeholder="" onSubmit=${(val) => {
        const r = parseIntFlag(val);
        if (!r.ok) return setErr(t('numInvalid'));
        setErr(null);
        if (r.value) set({ 'max-articles': r.value });
        setStep('aggressive');
      }} />
    </${Field}>`;
  }
  if (step === 'aggressive') {
    // Agressivo é o DEFAULT do crawler: "sim" força; "não" emite --no-aggressive (modo educado).
    return html`<${Field} label=${t('aggressivePrompt')}>
      <${Box} flexDirection="column">
        <${StatusMessage} variant="warning">${t('aggressiveWarn')}</${StatusMessage}>
        <${Select} options=${yesNo()} onChange=${(v) => {
          if (v === 'yes') set({ aggressive: true });
          else set({ 'no-aggressive': true });
          setStep(HAS_LLM ? 'classify' : 'review');
        }} />
      </${Box}>
    </${Field}>`;
  }
  if (step === 'classify') {
    return html`<${Field} label=${t('classifyAfter')}>
      <${Select} options=${yesNo()} onChange=${(v) => {
        if (v === 'no') set({ 'no-classify': true });
        setStep('review');
      }} />
    </${Field}>`;
  }
  // Resumo pré-execução: mostra as opções resolvidas (com destaque p/ o modo agressivo) e, abaixo,
  // o Review genérico (comando equivalente + Executar/Voltar). Agressivo é o DEFAULT do
  // crawler: efetivo = ligado, a menos que o usuário tenha escolhido "não" (--no-aggressive).
  const aggressiveOn = flags['no-aggressive'] !== true;
  return html`<${Box} flexDirection="column">
    <${Text} bold>${t('crawlSummary')}</${Text}>
    <${Box} flexDirection="column" marginY=${1}>
      <${Text}>${t('sinceLabel')}: <${Text} color="cyan">${flags.since || t('noneVal')}</${Text}></${Text}>
      <${Text}>${t('maxPagesLabel')}: <${Text} color="cyan">${flags['max-pages'] || t('noLimitVal')}</${Text}></${Text}>
      <${Text}>${t('maxArticlesLabel')}: <${Text} color="cyan">${flags['max-articles'] || t('noLimitVal')}</${Text}></${Text}>
      <${Text}>${t('aggressiveLabel')}: <${Text} color=${aggressiveOn ? 'red' : 'green'}>${aggressiveOn ? t('on') : t('off')}</${Text}></${Text}>
    </${Box}>
    ${aggressiveOn ? html`<${Alert} variant="warning">${t('aggressiveOn')}</${Alert}>` : null}
    <${Review} sub="crawl" flags=${flags} onRun=${onRun} onBack=${onBack} />
  </${Box}>`;
}

export function ExportConfig({ onRun, onBack }) {
  const [step, setStep] = useState('format');
  const [flags, setFlags] = useState({});
  const set = (patch) => setFlags((f) => ({ ...f, ...patch }));
  if (step === 'format') {
    return html`<${Field} label=${t('exportFormat')}>
      <${Select}
        options=${[
          { label: 'Markdown (.md)', value: 'md' },
          { label: 'JSON (.json)', value: 'json' },
        ]}
        onChange=${(v) => {
          set({ format: v });
          setStep('scope');
        }}
      />
    </${Field}>`;
  }
  if (step === 'scope') {
    return html`<${Field} label=${t('scopePrompt')}>
      <${Select}
        options=${[
          { label: t('scopeNew'), value: 'new' },
          { label: t('scopeAll'), value: 'all' },
        ]}
        onChange=${(v) => {
          if (v === 'all') set({ all: true });
          setStep('review');
        }}
      />
    </${Field}>`;
  }
  return html`<${Review} sub="export" flags=${flags} onRun=${onRun} onBack=${onBack} />`;
}

export function ClassifyConfig({ onRun, onBack }) {
  const [step, setStep] = useState('limit');
  const [flags, setFlags] = useState({});
  const [err, setErr] = useState(null);
  if (!HAS_LLM) {
    return html`<${Box} flexDirection="column">
      <${Alert} variant="error">${t('classifyNoLLM')}</${Alert}>
      <${Select} options=${[{ label: t('back'), value: 'back' }]} onChange=${onBack} />
    </${Box}>`;
  }
  if (step === 'limit') {
    return html`<${Field} label=${t('classifyLimit')} error=${err}>
      <${TextInput} key=${step} placeholder="" onSubmit=${(val) => {
        const r = parseIntFlag(val);
        if (!r.ok) return setErr(t('numInvalid'));
        setErr(null);
        if (r.value) setFlags((f) => ({ ...f, limit: r.value }));
        setStep('force');
      }} />
    </${Field}>`;
  }
  if (step === 'force') {
    return html`<${Field} label=${t('classifyForce')}>
      <${Select} options=${yesNo()} onChange=${(v) => {
        setFlags((f) => (v === 'yes' ? { ...f, force: true } : f));
        setStep('review');
      }} />
    </${Field}>`;
  }
  return html`<${Review} sub="classify" flags=${flags} onRun=${onRun} onBack=${onBack} />`;
}

export function SummarizeConfig({ onRun, onBack }) {
  const [step, setStep] = useState('limit');
  const [flags, setFlags] = useState({});
  const [err, setErr] = useState(null);
  if (!HAS_LLM) {
    return html`<${Box} flexDirection="column">
      <${Alert} variant="error">${t('summarizeNoLLM')}</${Alert}>
      <${Select} options=${[{ label: t('back'), value: 'back' }]} onChange=${onBack} />
    </${Box}>`;
  }
  if (step === 'limit') {
    return html`<${Field} label=${t('summarizeLimit')} error=${err}>
      <${TextInput} key=${step} placeholder="" onSubmit=${(val) => {
        const r = parseIntFlag(val);
        if (!r.ok) return setErr(t('numInvalid'));
        setErr(null);
        if (r.value) setFlags((f) => ({ ...f, limit: r.value }));
        setStep('force');
      }} />
    </${Field}>`;
  }
  if (step === 'force') {
    return html`<${Field} label=${t('summarizeForce')}>
      <${Select} options=${yesNo()} onChange=${(v) => {
        setFlags((f) => (v === 'yes' ? { ...f, force: true } : f));
        setStep('review');
      }} />
    </${Field}>`;
  }
  return html`<${Review} sub="summarize" flags=${flags} onRun=${onRun} onBack=${onBack} />`;
}

export function SearchConfig({ onRun, onBack }) {
  const [step, setStep] = useState('query');
  const [flags, setFlags] = useState({});
  const [query, setQuery] = useState('');
  const [err, setErr] = useState(null);
  if (!HAS_LLM) {
    return html`<${Box} flexDirection="column">
      <${Alert} variant="error">${t('searchNoLLM')}</${Alert}>
      <${Select} options=${[{ label: t('back'), value: 'back' }]} onChange=${onBack} />
    </${Box}>`;
  }
  if (step === 'query') {
    return html`<${Field} label=${t('searchQuery')} error=${err}>
      <${TextInput} key=${step} placeholder="ex.: react server components" onSubmit=${(val) => {
        const v = val.trim();
        if (!v) return setErr(t('searchEmptyQuery'));
        setErr(null);
        setQuery(v);
        setStep('scope');
      }} />
    </${Field}>`;
  }
  if (step === 'scope') {
    return html`<${Field} label=${t('scopePrompt')}>
      <${Select} options=${[
        { label: t('scopeNew'), value: 'new' },
        { label: t('scopeAll'), value: 'all' },
      ]} onChange=${(v) => {
        if (v === 'all') setFlags((f) => ({ ...f, all: true }));
        setStep('mode');
      }} />
    </${Field}>`;
  }
  if (step === 'mode') {
    return html`<${Field} label=${t('searchMode')}>
      <${Select} options=${[
        { label: t('searchModeA'), value: 'A' },
        { label: t('searchModeB'), value: 'B' },
      ]} onChange=${(v) => {
        setFlags((f) => ({ ...f, mode: v }));
        if (v === 'B') return setStep(getStatus().classified === 0 ? 'noclass' : 'review');
        setStep('confirmA'); // modo A sempre confirma (e seta --yes p/ não ser recusado)
      }} />
    </${Field}>`;
  }
  if (step === 'noclass') {
    return html`<${Box} flexDirection="column">
      <${StatusMessage} variant="warning">${t('searchNoClass')}</${StatusMessage}>
      <${Select} options=${[
        { label: t('searchModeA'), value: 'A' },
        { label: t('back'), value: 'back' },
      ]} onChange=${(v) => {
        if (v === 'back') return onBack();
        setFlags((f) => ({ ...f, mode: 'A' }));
        setStep('confirmA');
      }} />
    </${Box}>`;
  }
  if (step === 'confirmA') {
    return html`<${Field} label=${t('searchCostWarn', { n: getStatus().articles })}>
      <${Select} options=${yesNo()} onChange=${(v) => {
        if (v !== 'yes') return onBack();
        setFlags((f) => ({ ...f, yes: true }));
        setStep('review');
      }} />
    </${Field}>`;
  }
  return html`<${Review} sub="search" flags=${flags} rest=${[query]} onRun=${onRun} onBack=${onBack} />`;
}

export function AddConfig({ onRun, onBack }) {
  const [step, setStep] = useState('url');
  const [url, setUrl] = useState('');
  const [flags, setFlags] = useState({});
  const [err, setErr] = useState(null);

  if (step === 'url') {
    return html`<${Field} label=${t('addUrl')} error=${err}>
      <${TextInput} key=${step} placeholder="https://exemplo.com/arquivo" onSubmit=${(val) => {
        const v = val.trim();
        if (!v) return setErr(t('urlRequired'));
        setErr(null);
        setUrl(v);
        setStep('name');
      }} />
    </${Field}>`;
  }
  if (step === 'name') {
    return html`<${Field} label=${t('addName')}>
      <${TextInput} key=${step} placeholder="" onSubmit=${(val) => {
        const v = val.trim();
        if (v) setFlags((f) => ({ ...f, name: v }));
        setStep('type');
      }} />
    </${Field}>`;
  }
  if (step === 'type') {
    return html`<${Field} label=${t('addType')}>
      <${Select} options=${[
        { label: t('typeListing'), value: 'listing' },
        { label: t('typeIndex'), value: 'index' },
      ]} onChange=${(v) => {
        setFlags((f) => ({ ...f, type: v }));
        setStep('maxidx');
      }} />
    </${Field}>`;
  }
  if (step === 'maxidx') {
    return html`<${Field} label=${t('addMaxIdx')} error=${err}>
      <${TextInput} key=${step} placeholder="" onSubmit=${(val) => {
        const r = parseIntFlag(val);
        if (!r.ok) return setErr(t('numInvalid'));
        setErr(null);
        if (r.value) setFlags((f) => ({ ...f, 'max-index-pages': r.value }));
        setStep('review');
      }} />
    </${Field}>`;
  }
  return html`<${Review} sub="add" flags=${flags} rest=${[url]} onRun=${onRun} onBack=${onBack} />`;
}

// Buscador web: servidor LONG-RUNNING, então a tela é dona do ciclo de vida (não passa pela
// RunView, que espera um thunk finito): sobe no mount, fecha no unmount/q/Esc. Só useInput
// montado na fase "run" (regra do foco: um input por vez).
function WebRun({ port, onBack }) {
  const [state, setState] = useState({ phase: 'starting' });
  const srvRef = useRef(null);

  useEffect(() => {
    let alive = true;
    startWebServer({ port, open: true })
      .then((srv) => {
        if (!alive) return srv.close(); // desmontou antes de subir
        srvRef.current = srv;
        setState({ phase: 'up', url: srv.url });
      })
      .catch((e) => alive && setState({ phase: 'error', error: e?.message || String(e) }));
    return () => {
      alive = false;
      srvRef.current?.close();
      srvRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((input, key) => {
    if (input === 'q' || key.escape) onBack(); // o cleanup do effect fecha o servidor
    else if (input === 'o' && state.phase === 'up') openBrowser(state.url);
  });

  return html`<${Box} flexDirection="column">
    ${state.phase === 'starting' ? html`<${Spinner} label=${t('webStarting')} />` : null}
    ${state.phase === 'up'
      ? html`<${StatusMessage} variant="success">${t('webUp', { url: state.url })}</${StatusMessage}>`
      : null}
    ${state.phase === 'error'
      ? html`<${Alert} variant="error">${t('webFail', { err: state.error })}</${Alert}>`
      : null}
    <${Box} marginTop=${1}><${Text} dimColor>${t('webHint')}</${Text}></${Box}>
  </${Box}>`;
}

export function WebConfig({ onBack }) {
  const [step, setStep] = useState('port');
  const [port, setPort] = useState(undefined);
  const [err, setErr] = useState(null);
  if (step === 'port') {
    return html`<${Field} label=${t('webPortPrompt')} error=${err}>
      <${TextInput} placeholder="8477" onSubmit=${(val) => {
        const r = parseIntFlag(val);
        if (!r.ok) return setErr(t('numInvalid'));
        setErr(null);
        setPort(r.value ? Number(r.value) : undefined);
        setStep('run');
      }} />
    </${Field}>`;
  }
  return html`<${WebRun} port=${port} onBack=${onBack} />`;
}

// Tela de limites (orçamento/paralelismo/RAM): wizard por step; persiste em NC_HOME/.env com o
// MESMO helper do `key set` (upsertEnvVar). Não é um "run": salva e volta ao menu.
export function LimitsConfig({ onBack }) {
  const [step, setStep] = useState('budget');
  const [vals, setVals] = useState({});
  const [err, setErr] = useState(null);
  const [savedTo, setSavedTo] = useState(null);

  if (step === 'budget') {
    return html`<${Field} label=${t('limitsBudget')} error=${err}>
      <${Text} dimColor>${BUDGET_USD > 0 ? `US$ ${BUDGET_USD.toFixed(2)}` : '∞'}</${Text}>
      <${TextInput} placeholder="" onSubmit=${(val) => {
        const v = val.trim();
        if (v && (!Number.isFinite(Number(v)) || Number(v) < 0)) return setErr(t('limitsInvalidBudget'));
        setErr(null);
        if (v) setVals((x) => ({ ...x, BUDGET_USD: String(Number(v)) }));
        setStep('parallel');
      }} />
    </${Field}>`;
  }
  if (step === 'parallel') {
    return html`<${Field} label=${t('limitsParallel')} error=${err}>
      <${Text} dimColor>${String(MAX_PARALLEL)}</${Text}>
      <${TextInput} placeholder="" onSubmit=${(val) => {
        const r = parseIntFlag(val);
        if (!r.ok) return setErr(t('numInvalid'));
        setErr(null);
        if (r.value) setVals((x) => ({ ...x, MAX_PARALLEL: r.value }));
        setStep('ram');
      }} />
    </${Field}>`;
  }
  if (step === 'ram') {
    return html`<${Field} label=${t('limitsRam')} error=${err}>
      <${Text} dimColor>${`${RAM_MAX_PCT}%`}</${Text}>
      <${TextInput} placeholder="80" onSubmit=${(val) => {
        const v = val.trim();
        if (v && (!Number.isFinite(Number(v)) || Number(v) < 10 || Number(v) > 95)) {
          return setErr(t('limitsInvalidRam'));
        }
        setErr(null);
        const next = v ? { ...vals, RAM_MAX_PCT: String(Number(v)) } : vals;
        let file = null;
        for (const [k, value] of Object.entries(next)) file = upsertEnvVar(k, value).file;
        setSavedTo(file);
        setStep('done');
      }} />
    </${Field}>`;
  }
  return html`<${Box} flexDirection="column">
    <${StatusMessage} variant=${savedTo ? 'success' : 'info'}>
      ${savedTo ? t('limitsSaved', { file: savedTo }) : t('limitsNothing')}
    </${StatusMessage}>
    <${Select} options=${[{ label: t('back'), value: 'back' }]} onChange=${onBack} />
  </${Box}>`;
}
export function ResetConfirm({ onRun, onBack }) {
  return html`<${Box} flexDirection="column">
    <${Alert} variant="error">${t('resetWarn')}</${Alert}>
    <${Box} marginTop=${1}>
      <${Select}
        options=${[
          { label: t('resetCancel'), value: 'cancel' },
          { label: t('resetGo'), value: 'go' },
        ]}
        onChange=${(v) => (v === 'go' ? onRun({ sub: 'reset', flags: { yes: true } }) : onBack())}
      />
    </${Box}>
  </${Box}>`;
}
