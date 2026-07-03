import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { fades, springs } from '../motion/transitions.js';
import { STR } from '../strings.js';

/**
 * Chave OpenRouter (BYOK): valida via probe e salva SÓ no navegador (localStorage). Abre
 * quando o usuário tenta buscar sem chave, ou quando a salva é recusada (401 → reason invalid).
 */
export default function KeyModal({ modal, hasStoredKey, onSave, onDismiss, onForget }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!modal) return undefined;
    const onKey = (e) => e.key === 'Escape' && onDismiss();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modal, onDismiss]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(value);
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
            aria-label={STR.keyTitle}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.92, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 6 }}
            transition={springs.snappy}
          >
            <h2 className="dialog-title">{modal.reason === 'manage' ? STR.keyManageTitle : STR.keyTitle}</h2>
            {modal.reason === 'invalid' && <p className="dialog-warn">{STR.keyExpired}</p>}
            <p className="dialog-body">{modal.reason === 'manage' ? STR.keyManageBody : STR.keyBody}</p>
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
                placeholder={STR.keyPlaceholder}
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
              {STR.keyHint}{' '}
              <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">
                openrouter.ai/keys ↗
              </a>
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
