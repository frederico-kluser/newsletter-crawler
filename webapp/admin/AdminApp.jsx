// Página /admin — acesso mediante login e senha, configuração da análise JEV (input + o MESMO
// filtro de data do site), cadastro do webhook de disparo, execução com progresso ao vivo e
// histórico de runs. Toda a fala de UI vem do DICTS (paridade pt/en garantida pelo i18n.test).
import { useCallback, useEffect, useRef, useState } from 'react';
import LanguageToggle from '../src/components/LanguageToggle.jsx';
import ThemeToggle from '../src/components/ThemeToggle.jsx';
import { useStrings } from '../src/i18n.jsx';
import { useTheme } from '../src/hooks/useTheme.js';
import { fmtDate } from '../src/lib/format.js';
import { fmtInt, fmtUsd } from '../src/strings.js';
import { api } from './api.js';

const EMPTY_CFG = { input: '', from: '', to: '', sourceIds: [], kind: 'all', threshold: 0.5, batchSize: 25, webhookUrl: '' };
const KINDS = ['all', 'news', 'tool', 'release'];

export default function AdminApp() {
  const STR = useStrings();
  const A = STR.admin;
  const { theme, toggle } = useTheme();

  const [phase, setPhase] = useState('boot'); // boot | login | unconfigured | ready
  const [info, setInfo] = useState(null);
  const [cfg, setCfg] = useState(EMPTY_CFG);
  const [sources, setSources] = useState([]);
  const [scope, setScope] = useState(null);
  const [runs, setRuns] = useState([]);
  const [current, setCurrent] = useState(null); // run em foco (execução atual ou detalhe)
  const [busy, setBusy] = useState(''); // '' | 'login' | 'save' | 'test' | 'run'
  const [notice, setNotice] = useState(null); // {kind: 'ok'|'error'|'info', text}
  const runningRef = useRef(false);

  const boot = useCallback(async () => {
    try {
      const s = await api.session();
      setInfo(s);
      const [{ config }, runsRes] = await Promise.all([api.config(), api.runs().catch(() => ({ runs: [] }))]);
      setCfg({ ...EMPTY_CFG, ...config });
      setRuns(runsRes.runs || []);
      setPhase('ready');
    } catch (err) {
      if (err.status === 401) setPhase('login');
      else if (err.status === 503) setPhase('unconfigured');
      else setNotice({ kind: 'error', text: err.message });
    }
  }, []);

  useEffect(() => {
    boot();
  }, [boot]);

  // fontes (para o multi-select) vêm do snapshot público — mesma lista do site
  useEffect(() => {
    if (phase !== 'ready') return;
    fetch('/data/meta.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((meta) => setSources(Array.isArray(meta?.sources) ? [...meta.sources].sort((a, b) => a.name.localeCompare(b.name)) : []))
      .catch(() => setSources([]));
  }, [phase]);

  // estimativa de escopo/custo ao vivo (debounce) — mesma semântica de filtro do site
  useEffect(() => {
    if (phase !== 'ready') return;
    setScope(null);
    const t = setTimeout(() => {
      api
        .scope(cfg)
        .then(setScope)
        .catch(() => setScope(null));
    }, 500);
    return () => clearTimeout(t);
  }, [phase, cfg]);

  const patch = (p) => setCfg((c) => ({ ...c, ...p }));

  const toggleSource = (id) =>
    setCfg((c) => ({
      ...c,
      sourceIds: c.sourceIds.includes(id) ? c.sourceIds.filter((x) => x !== id) : [...c.sourceIds, id],
    }));

  async function onSave() {
    setBusy('save');
    setNotice(null);
    try {
      const { config } = await api.saveConfig({
        input: cfg.input,
        from: cfg.from,
        to: cfg.to,
        sourceIds: cfg.sourceIds,
        kind: cfg.kind,
        threshold: Number(cfg.threshold),
        batchSize: Number(cfg.batchSize),
        webhookUrl: cfg.webhookUrl,
      });
      setCfg({ ...EMPTY_CFG, ...config });
      setNotice({ kind: 'ok', text: A.saved });
    } catch (err) {
      setNotice({ kind: 'error', text: `${A.saveFailed}: ${err.message}` });
    } finally {
      setBusy('');
    }
  }

  async function onTestWebhook() {
    setBusy('test');
    setNotice(null);
    try {
      const { result } = await api.testWebhook();
      setNotice(
        result?.ok
          ? { kind: 'ok', text: A.webhookTestOk(result.status) }
          : { kind: 'error', text: A.webhookTestBad(result?.error || String(result?.status || '')) },
      );
    } catch (err) {
      setNotice({ kind: 'error', text: A.webhookTestBad(err.message) });
    } finally {
      setBusy('');
    }
  }

  // conduz uma run até ao fim (step loop) — a mesma rotina serve p/ executar e retomar
  const driveRun = useCallback(
    async (runId) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setBusy('run');
      setNotice(null);
      try {
        let run = runId ? await api.run(runId).then((r) => r.run) : await api.startRun().then((r) => r.run);
        setCurrent(run);
        while (run.status === 'running') {
          setNotice({ kind: 'info', text: A.runProgress(run.progress.done, run.progress.total) });
          run = await api.stepRun(run.id).then((r) => r.run);
          setCurrent(run);
        }
        setNotice({
          kind: run.status === 'done' ? 'ok' : 'error',
          text:
            run.status === 'done'
              ? `${A.runSeparadas(run.matchesTotal ?? run.matches.length)} · ${
                  run.dispatch?.ok ? A.runDispatchOk(run.matchesTotal ?? run.matches.length) : run.dispatch?.skipped ? A.runDispatchSkipped : A.runDispatchFail(run.dispatch?.error || '')
                }`
              : A.runFailed(run.error || ''),
        });
        api.runs().then((r) => setRuns(r.runs || [])).catch(() => {});
      } catch (err) {
        setNotice({ kind: 'error', text: A.runFailed(err.message) });
      } finally {
        runningRef.current = false;
        setBusy('');
      }
    },
    [A],
  );

  async function onRedispatch() {
    if (!current) return;
    setBusy('test');
    try {
      const { run } = await api.redispatch(current.id);
      setCurrent(run);
      setNotice(
        run.dispatch?.ok
          ? { kind: 'ok', text: A.runDispatchOk(run.matchesTotal ?? run.matches.length) }
          : { kind: 'error', text: A.runDispatchFail(run.dispatch?.error || '') },
      );
    } catch (err) {
      setNotice({ kind: 'error', text: A.runDispatchFail(err.message) });
    } finally {
      setBusy('');
    }
  }

  async function onOpenRun(id) {
    try {
      const { run } = await api.run(id);
      setCurrent(run);
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
    }
  }

  async function onLogout() {
    try {
      await api.logout();
    } finally {
      setPhase('login');
      setInfo(null);
      setCurrent(null);
    }
  }

  return (
    <div className="app adm">
      <header className="topbar">
        <div className="topbar-inner adm-top">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              ◈
            </span>
            <span className="brand-text">
              <span className="brand-name">{STR.brand}</span>
              <span className="brand-tag">{A.title}</span>
            </span>
          </div>
          <div className="topbar-right">
            <LanguageToggle layoutId="lang-pill-admin" />
            <ThemeToggle theme={theme} onToggle={toggle} />
            {phase === 'ready' && (
              <button type="button" className="btn" onClick={onLogout}>
                {A.logout}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="adm-main">
        <p className="adm-subtitle">{A.subtitle}</p>
        {notice && <div className={`adm-notice adm-notice-${notice.kind}`}>{notice.text}</div>}

        {phase === 'boot' && <p className="adm-muted">{A.booting}</p>}

        {phase === 'unconfigured' && (
          <section className="adm-card">
            <h2>{A.notConfiguredTitle}</h2>
            <p className="adm-muted">{A.notConfiguredBody}</p>
          </section>
        )}

        {phase === 'login' && (
          <LoginForm
            A={A}
            busy={busy === 'login'}
            onLogin={async (user, password) => {
              setBusy('login');
              setNotice(null);
              try {
                await api.login(user, password);
                await boot();
              } catch (err) {
                setNotice({ kind: 'error', text: err.status === 401 ? A.loginError : err.message });
                setPhase('login');
              } finally {
                setBusy('');
              }
            }}
          />
        )}

        {phase === 'ready' && (
          <>
            {!info?.keyPresent && <div className="adm-notice adm-notice-error">{A.keyMissing}</div>}
            {!info?.kvPresent && <div className="adm-notice adm-notice-error">{A.kvMissing}</div>}
            {info?.configSource === 'env' && <div className="adm-notice adm-notice-info">{A.configSourceEnv}</div>}

            <section className="adm-card">
              <h2>{A.analysisTitle}</h2>
              <label className="adm-label" htmlFor="adm-input">
                {A.inputLabel}
              </label>
              <textarea
                id="adm-input"
                className="input adm-input"
                rows={3}
                maxLength={2000}
                placeholder={A.inputPlaceholder}
                value={cfg.input}
                onChange={(e) => patch({ input: e.target.value })}
              />
              <p className="adm-hint">{A.inputHint}</p>

              <div className="adm-grid">
                <div>
                  <span className="adm-label">{A.periodLabel}</span>
                  <div className="date-row">
                    <label className="adm-small">
                      {A.fromLabel}
                      <input
                        type="date"
                        className="input date-field"
                        value={cfg.from}
                        onChange={(e) => patch({ from: e.target.value })}
                      />
                    </label>
                    <label className="adm-small">
                      {A.toLabel}
                      <input
                        type="date"
                        className="input date-field"
                        value={cfg.to}
                        onChange={(e) => patch({ to: e.target.value })}
                      />
                    </label>
                  </div>
                </div>
                <div>
                  <label className="adm-label" htmlFor="adm-kind">
                    {A.kindLabel}
                  </label>
                  <select id="adm-kind" className="input" value={cfg.kind} onChange={(e) => patch({ kind: e.target.value })}>
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {A[`kind${k[0].toUpperCase()}${k.slice(1)}`]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="filter-block adm-sources">
                <span className="adm-label">{A.sourcesLabel}</span>
                <div className="adm-source-list">
                  <label className="adm-check">
                    <input
                      type="checkbox"
                      checked={cfg.sourceIds.length === 0}
                      onChange={() => patch({ sourceIds: [] })}
                    />
                    {A.sourcesAll}
                  </label>
                  {sources.map((s) => (
                    <label key={s.id} className="adm-check">
                      <input type="checkbox" checked={cfg.sourceIds.includes(s.id)} onChange={() => toggleSource(s.id)} />
                      {s.name}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="adm-label" htmlFor="adm-th">
                  {A.thresholdLabel}: {Number(cfg.threshold).toFixed(2)}
                </label>
                <input
                  id="adm-th"
                  type="range"
                  min="0.05"
                  max="0.95"
                  step="0.05"
                  value={cfg.threshold}
                  onChange={(e) => patch({ threshold: Number(e.target.value) })}
                />
                <p className="adm-hint">{A.thresholdHint}</p>
              </div>

              <div>
                <label className="adm-label" htmlFor="adm-batch">
                  {A.batchLabel}
                </label>
                <input
                  id="adm-batch"
                  className="input adm-batch"
                  type="number"
                  min="1"
                  max="25"
                  step="1"
                  value={cfg.batchSize}
                  onChange={(e) => patch({ batchSize: e.target.value === '' ? '' : Number(e.target.value) })}
                />
                <p className="adm-hint">{A.batchHint}</p>
              </div>

              <div className="adm-actions">
                <button type="button" className="btn btn-primary" disabled={busy === 'save'} onClick={onSave}>
                  {A.save}
                </button>
                <span className="adm-muted">
                  {scope ? A.estimate(fmtInt(scope.total), fmtUsd(scope.estUsd)) : A.scopeLoading}
                </span>
              </div>
            </section>

            <section className="adm-card">
              <h2>{A.webhookTitle}</h2>
              <label className="adm-label" htmlFor="adm-webhook">
                {A.webhookLabel}
              </label>
              <input
                id="adm-webhook"
                className="input"
                type="url"
                placeholder="https://…"
                value={cfg.webhookUrl}
                onChange={(e) => patch({ webhookUrl: e.target.value })}
              />
              <p className="adm-hint">{A.webhookHint}</p>
              {!cfg.webhookUrl && <div className="adm-notice adm-notice-info">{A.webhookMissing}</div>}
              <div className="adm-actions">
                <button type="button" className="btn btn-primary" disabled={busy === 'save'} onClick={onSave}>
                  {A.save}
                </button>
                <button type="button" className="btn" disabled={busy === 'test' || !cfg.webhookUrl} onClick={onTestWebhook}>
                  {A.webhookTest}
                </button>
              </div>
            </section>

            <section className="adm-card">
              <h2>{A.runTitle}</h2>
              <div className="adm-actions">
                <button type="button" className="btn btn-primary" disabled={busy !== '' || !cfg.input} onClick={() => driveRun(null)}>
                  {busy === 'run' ? A.runBusy : A.runBtn}
                </button>
                <span className="adm-muted">{A.nightlyNote}</span>
              </div>
              {current && <RunPanel A={A} run={current} busy={busy} onRedispatch={onRedispatch} onResume={() => driveRun(current.id)} />}
            </section>

            <section className="adm-card">
              <h2>{A.historyTitle}</h2>
              {runs.length === 0 && <p className="adm-muted">{A.historyEmpty}</p>}
              <div className="history-list">
                {runs.map((r) => (
                  <button key={r.id} type="button" className="history-row adm-run-row" onClick={() => onOpenRun(r.id)}>
                    <span className="history-main">
                      <span className="history-query">
                        {fmtDate(r.startedAt?.slice(0, 10))} · {A[`trigger${r.trigger[0].toUpperCase()}${r.trigger.slice(1)}`]}
                      </span>
                      <span className="history-meta">
                        {A[`runStatus${r.status[0].toUpperCase()}${r.status.slice(1)}`]} · {A.runSeparadas(r.matched)}
                        {r.costUsd ? ` · ${A.costLabel} ${fmtUsd(r.costUsd)}` : ''}
                      </span>
                    </span>
                    <span className="badge badge-verify">{r.dispatchOk === true ? '✓' : r.dispatchOk === false ? '✗' : '–'}</span>
                  </button>
                ))}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function LoginForm({ A, busy, onLogin }) {
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  return (
    <section className="adm-card adm-login">
      <h2>{A.loginTitle}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onLogin(user, password);
        }}
      >
        <label className="adm-label" htmlFor="adm-user">
          {A.user}
        </label>
        <input id="adm-user" className="input" autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} />
        <label className="adm-label" htmlFor="adm-pass">
          {A.password}
        </label>
        <input
          id="adm-pass"
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="adm-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !user || !password}>
            {A.loginBtn}
          </button>
        </div>
      </form>
    </section>
  );
}

function RunPanel({ A, run, busy, onRedispatch, onResume }) {
  const total = run.progress?.total || 0;
  const done = run.progress?.done || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const matched = run.matchesTotal ?? (run.matches || []).length;
  return (
    <div className="adm-run">
      <div className="adm-run-head">
        <span className="badge">{A[`runStatus${run.status[0].toUpperCase()}${run.status.slice(1)}`]}</span>
        <span className="adm-muted">
          {A.modelLabel} {run.model || run.config?.jevModel || '—'}
          {run.usage?.cost ? ` · ${A.costLabel} ${fmtUsd(run.usage.cost)}` : ''}
          {run.injectionFlagged ? ` · ${A.injectionNote(run.injectionFlagged)}` : ''}
        </span>
      </div>
      {run.status === 'running' && (
        <>
          <div className="ai-progress-track">
            <div className="ai-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <p className="adm-muted">
            {A.runProgress(done, total)} · {A.runScanned(run.progress?.processed || 0)} · {A.runSeparadas(matched)}
          </p>
        </>
      )}
      {run.status !== 'running' && (
        <p className="adm-muted">
          {A.runScanned(run.progress?.processed || 0)} · {A.runSeparadas(matched)}
          {run.dispatch?.ok
            ? ` · ${A.runDispatchOk(matched)}`
            : run.dispatch?.skipped
              ? ` · ${A.runDispatchSkipped}`
              : run.dispatch
                ? ` · ${A.runDispatchFail(run.dispatch.error || '')}`
                : ''}
        </p>
      )}
      {run.status === 'error' && <div className="adm-notice adm-notice-error">{A.runFailed(run.error || '')}</div>}
      <div className="adm-actions">
        {run.status === 'running' && busy !== 'run' && (
          <button type="button" className="btn" onClick={onResume}>
            {A.runResume}
          </button>
        )}
        {run.status === 'done' && matched > 0 && (
          <button type="button" className="btn" disabled={busy !== ''} onClick={onRedispatch}>
            {A.runRedispatch}
          </button>
        )}
      </div>
      {matched > 0 && (
        <>
          <h3 className="adm-matches-title">{A.matchesTitle(matched)}</h3>
          <ul className="adm-matches">
            {(run.matches || []).map((m) => (
              <li key={m.id} className="adm-match">
                <a href={m.url} target="_blank" rel="noreferrer">
                  {m.title}
                </a>
                <span className="adm-muted">
                  {fmtDate(m.date_iso)} · {m.source?.name || ''} · {A.matchP(Number(m.jev?.p ?? 0).toFixed(2))}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
