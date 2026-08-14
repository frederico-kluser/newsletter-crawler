import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { fades, springs } from '../motion/transitions.js';
import { useStrings } from '../i18n.jsx';
import { getApiKey, getProvider } from '../lib/storage.js';
import { probeKey } from '../lib/openrouter.js';

// Os DOIS provedores, um slot de chave cada (nc-or-key / nc-ds-key): o usuário pode guardar as
// duas, TESTAR cada uma (probe sem salvar) e ESCOLHER a ativa — a busca IA usa a chave do
// provedor ativo (nc-llm-provider). Salvar uma chave a ativa; a linha ativa fica destacada.
const PROVIDERS = [
  { id: 'openrouter', hintLink: 'https://openrouter.ai/keys' },
  { id: 'deepseek', hintLink: 'https://platform.deepseek.com/api_keys' },
];

export default function KeyModal({ modal, onSave, onDismiss, onForget, onSelect }) {
  const STR = useStrings();
  const [busy, setBusy] = useState(false); // operação em voo (salvar/trocar) — trava tudo
  const [error, setError] = useState(null);
  // estado por linha: valor digitado + resultado do TESTE (probe sem salvar)
  const [rows, setRows] = useState(() => ({
    openrouter: { value: '', testing: false, result: null },
    deepseek: { value: '', testing: false, result: null },
  }));
  const setRow = (id, patch) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));

  // presença das chaves salvas lida FRESCA a cada render (o modal fica montado no App)
  const saved = {
    openrouter: Boolean(getApiKey('openrouter')),
    deepseek: Boolean(getApiKey('deepseek')),
  };
  const active = getProvider();

  const test = async (id) => {
    const k = rows[id].value.trim();
    if (!k) return;
    setRow(id, { testing: true, result: null });
    const probe = await probeKey(k, id); // NÃO salva — só valida (probe do provedor)
    setRow(id, {
      testing: false,
      result: probe.ok ? 'ok' : probe.status === 0 ? 'network' : 'invalid',
    });
  };

  const save = async (id) => {
    setBusy(true);
    setError(null);
    try {
      await onSave(rows[id].value, id); // valida + salva no slot do provedor + ATIVA
      setRow(id, { value: '', result: null });
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const activate = async (id) => {
    if (id === active) return;
    setBusy(true);
    setError(null);
    try {
      await onSelect(id); // troca o provedor ativo (chave já salva no slot)
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const forget = (id) => {
    onForget(id); // esquece o slot do provedor; se era o ativo, o hasKey recalcula
  };

  const isDs = (id) => id === 'deepseek';
  const title = STR.keyTitleAll;
  const body = modal?.reason === 'manage' ? STR.keyManageBodyAll : STR.keyBodyAll;

  return (
    <AnimatePresence>
      {modal && (
        <motion.div
          className="overlay overlay-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fades.base}
          onClick={onDismiss}
        >
          <motion.div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.92, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 6 }}
            transition={springs.snappy}
          >
            <h2 className="dialog-title">{title}</h2>
            {modal.reason === 'invalid' && (
              <p className="dialog-warn">{active === 'deepseek' ? STR.keyExpiredDs : STR.keyExpired}</p>
            )}
            <p className="dialog-body">{body}</p>

            <div className="key-manager">
              {PROVIDERS.map(({ id, hintLink }) => {
                const row = rows[id];
                const isActive = id === active;
                const savedNow = saved[id];
                const invalidMsg = isDs(id) ? STR.keyInvalidDs : STR.keyInvalid;
                return (
                  <section
                    key={id}
                    className={`key-manager-row${isActive ? ' key-manager-row-active' : ''}`}
                    aria-label={isDs(id) ? STR.keyProviderDeepSeek : STR.keyProviderOr}
                  >
                    <header className="key-manager-head">
                      <strong>{isDs(id) ? STR.keyProviderDeepSeek : STR.keyProviderOr}</strong>
                      {isActive ? (
                        <span className="key-manager-badge key-manager-badge-active">{STR.keyActive}</span>
                      ) : savedNow ? (
                        <span className="key-manager-badge">{STR.keySaved}</span>
                      ) : (
                        <span className="key-manager-badge key-manager-badge-empty">{STR.keyNoKey}</span>
                      )}
                    </header>

                    <div className="key-row">
                      <input
                        type="password"
                        className="input"
                        placeholder={isDs(id) ? STR.keyPlaceholderDs : STR.keyPlaceholder}
                        value={row.value}
                        onChange={(e) => setRow(id, { value: e.target.value, result: null })}
                        autoComplete="off"
                        autoFocus={!savedNow && isActive}
                      />
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={busy || !row.value.trim() || row.testing}
                        onClick={() => test(id)}
                      >
                        {row.testing ? STR.keyTesting : STR.keyTest}
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busy || !row.value.trim()}
                        onClick={() => save(id)}
                      >
                        {STR.keySave}
                      </button>
                    </div>
                    {row.result === 'ok' && <p className="key-manager-result key-manager-result-ok">{STR.keyTestOk}</p>}
                    {row.result === 'invalid' && <p className="key-manager-result key-manager-result-bad">{invalidMsg}</p>}
                    {row.result === 'network' && <p className="key-manager-result key-manager-result-bad">{STR.keyNetwork}</p>}

                    {savedNow && (
                      <footer className="key-manager-actions">
                        <button
                          type="button"
                          className="pill pill-primary"
                          disabled={busy || isActive}
                          onClick={() => activate(id)}
                        >
                          {isActive ? STR.keyActive : STR.keyActivate}
                        </button>
                        <button type="button" className="pill pill-clear" disabled={busy} onClick={() => forget(id)}>
                          {STR.keyForget}
                        </button>
                        <a className="key-manager-link" href={hintLink} target="_blank" rel="noopener noreferrer">
                          {isDs(id) ? 'platform.deepseek.com/api_keys ↗' : 'openrouter.ai/keys ↗'}
                        </a>
                      </footer>
                    )}
                  </section>
                );
              })}
            </div>

            {error && (
              <p className="dialog-warn" role="alert">
                {error}
              </p>
            )}
            <p className="dialog-hint">{STR.keyHintAll}</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
