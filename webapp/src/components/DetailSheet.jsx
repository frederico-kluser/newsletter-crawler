import { motion, useDragControls } from 'motion/react';
import { useEffect, useState } from 'react';
import { getContent } from '../lib/data.js';
import { fades, springs } from '../motion/transitions.js';
import { FACET_LABEL, KIND_LABEL, STR, VERIFY_LABEL } from '../strings.js';
import { fmtDate } from '../lib/format.js';
import { effectiveKind } from '../lib/taxonomy.js';

/**
 * Preview do artigo. Desktop: modal central (scale+fade). Mobile: bottom sheet com
 * DRAG-TO-DISMISS a partir do cabeçalho (useDragControls + dragListener=false — o corpo
 * continua rolando nativamente; arrastar tudo bloquearia o scroll via touch-action).
 * O corpo (content) é LAZY: baixa contents.json na 1ª abertura.
 */
export default function DetailSheet({ article: a, toolTypes, isMobile, onClose }) {
  const [content, setContent] = useState(null);
  const [failed, setFailed] = useState(false);
  const dragControls = useDragControls();

  useEffect(() => {
    let alive = true;
    setContent(null);
    setFailed(false);
    getContent(a.id).then(
      (c) => alive && setContent(c),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [a.id]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const kind = effectiveKind(a, toolTypes);
  const title = a.title_pt || a.title || a.url;
  const paragraphs = (content || '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 400);
  const facetEntries = Object.entries(a.tags || {});

  const drag = isMobile
    ? {
        drag: 'y',
        dragControls,
        dragListener: false,
        dragConstraints: { top: 0, bottom: 0 },
        dragElastic: { top: 0, bottom: 0.5 },
        onDragEnd: (e, info) => {
          if (info.offset.y > 120 || info.velocity.y > 800) onClose();
        },
      }
    : {};

  return (
    <motion.div
      className="overlay overlay-sheet"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={fades.base}
      onClick={onClose}
    >
      <motion.div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        initial={isMobile ? { y: '100%' } : { y: 24, opacity: 0, scale: 0.98 }}
        animate={isMobile ? { y: 0 } : { y: 0, opacity: 1, scale: 1 }}
        exit={isMobile ? { y: '100%' } : { y: 24, opacity: 0, scale: 0.98 }}
        transition={springs.sheet}
        {...drag}
      >
        <div
          className="sheet-head"
          style={isMobile ? { touchAction: 'none' } : undefined}
          onPointerDown={isMobile ? (e) => dragControls.start(e) : undefined}
        >
          {isMobile && <div className="drawer-handle" aria-hidden="true" />}
          <div className="sheet-head-row">
            <span className="sheet-eyebrow">
              {a.source_name || `fonte ${a.source_id}`}
              {a.date_iso ? ` · ${fmtDate(a.date_iso)}` : ''}
            </span>
            <button type="button" className="icon-btn" onClick={onClose} aria-label={STR.close}>
              ✕
            </button>
          </div>
        </div>

        <div className="sheet-body">
          <h2 className="sheet-title">{title}</h2>
          {a.title_pt && a.title && a.title !== a.title_pt && <p className="sheet-original">{a.title}</p>}
          <div className="sheet-badges">
            <span className="badge" data-kind={kind}>
              {KIND_LABEL[kind] || kind}
            </span>
            {a.verify_status && a.verify_status !== 'ok' && (
              <span className="badge badge-verify" data-verify={a.verify_status}>
                {VERIFY_LABEL[a.verify_status]}
              </span>
            )}
            {a.section && <span className="card-section">{a.section}</span>}
          </div>
          {a.summary_pt ? (
            <p className="sheet-lead">{a.summary_pt}</p>
          ) : (
            <p className="sheet-lead sheet-lead-missing">{STR.noSummary}</p>
          )}

          {content == null && !failed && <p className="sheet-loading">{STR.loading}</p>}
          {failed && <p className="sheet-loading">{STR.loadError}</p>}
          {paragraphs.length > 0 && (
            <div className="sheet-content">
              {paragraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          )}

          {facetEntries.length > 0 && (
            <div className="sheet-tags">
              {facetEntries.map(([facet, tags]) => (
                <div key={facet} className="sheet-tag-row">
                  <span className="sheet-tag-facet">{FACET_LABEL[facet] || facet}</span>
                  <span className="chip-row">
                    {tags.map((t) => (
                      <span key={t} className="chip chip-static">
                        {t}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="sheet-foot">
          <a className="btn btn-primary" href={a.url} target="_blank" rel="noopener noreferrer">
            {STR.readOriginal} ↗
          </a>
        </div>
      </motion.div>
    </motion.div>
  );
}
