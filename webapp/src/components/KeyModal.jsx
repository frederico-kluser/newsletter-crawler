import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { fades, springs } from '../motion/transitions.js';
import { useStrings } from '../i18n.jsx';
import { getProvider } from '../lib/storage.js';

/**
 * Chave LLM (BYOK): valida via probe e salva SÓ no navegador (localStorage). Abre quando o
 * usuário tenta buscar sem chave, ou quando a salva é recusada (401 → reason invalid).
 * Seletor de PROVEDOR: openrouter (default) | deepseek direto — a chave e o provedor são
 * salvos juntos; sem provedor salvo = openrouter (migração silenciosa).
 */
export default function KeyModal({ modal, hasStoredKey, onSave, onDismiss, onForget }) {
  const STR = useStrings();
  const [value, setValue] = useState('');
  const [provider, setProviderState] = useState(() => getProvider());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!modal) return undefined;
    setProviderState(getProvider()); // re-sincroniza o select com o provedor SALVO a cada abertura
    const onKey = (e) => e.key === 'Escape' && onDismiss();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modal, onDismiss]);

  const isDs = provider === 'deepseek';
  const title = isDs ? STR.keyTitleDs : STR.keyTitle;
  const manageTitle = isDs ? STR.keyManageTitleDs : STR.keyManageTitle;
  const body = isDs ? STR.keyBodyDs : STR.keyBody;
  const manageBody = isDs ? STR.keyManageBodyDs : STR.keyManageBody;
  const hint = isDs ? STR.keyHintDs : STR.keyHint;
  const placeholder = isDs ? STR.keyPlaceholderDs : STR.keyPlaceholder;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(value, provider);
      setValue('');
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

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
            <h2 className="dialog-title">{modal.reason === 'manage' ? manageTitle : title}</h2>
            {modal.reason === 'invalid' && <p className="dialog-warn">{isDs ? STR.keyExpiredDs : STR.keyExpired}</p>}
            <p className="dialog-body">{modal.reason === 'manage' ? manageBody : body}</p>
            <label className="dialog-body provider-select">
              <span>{STR.keyProviderLabel}</span>
              <select
                className="input"
                value={provider}
                onChange={(e) => setProviderState(e.target.value)}
                autoComplete="off"
              >
                <option value="openrouter">{STR.keyProviderOr}</option>
                <option value="deepseek">{STR.keyProviderDeepSeek}</option>
              </select>
            </label>
            <form
              className="key-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) save();
              }}
            >
              <input
                type="password"
                className="input"
                placeholder={placeholder}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="off"
                autoFocus
              />
              <button type="submit" className="btn btn-primary" disabled={busy || !value.trim()}>
                {busy ? STR.keySaving : STR.keySave}
              </button>
            </form>
            {error && (
              <p className="dialog-warn" role="alert">
                {error}
              </p>
            )}
            <p className="dialog-hint">
              {hint}{' '}
              {isDs ? (
                <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer">
                  platform.deepseek.com/api_keys ↗
                </a>
              ) : (
                <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">
                  openrouter.ai/keys ↗
                </a>
              )}
            </p>
            {hasStoredKey && (
              <button type="button" className="pill pill-clear" onClick={onForget}>
                {STR.keyForget}
              </button>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
