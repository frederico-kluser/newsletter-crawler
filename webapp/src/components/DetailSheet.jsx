import { useEffect, useState } from 'react';
import { Sheet } from '@/components/motion-ui/sheet';
import { CopyButton } from '@/components/motion-ui/copy-button';
import { ArrowLink } from '@/components/motion-ui/arrow-link';
import { getContent } from '../lib/data.js';
import { useStrings } from '../i18n.jsx';
import { fmtDate } from '../lib/format.js';
import { effectiveKind } from '../lib/taxonomy.js';
import { usePlayer } from '../player.jsx';
import PlayButton from './PlayButton.jsx';

/**
 * Preview editorial do artigo sobre o primitivo Sheet do Motion+ UI:
 * - Desktop: modal central com foco e entrada spring;
 * - Mobile: bottom sheet com drag-to-dismiss controlado pelo cabeçalho;
 * - Inclui CopyButton (copiar link e copiar resumo), TTS PlayButton e tags clicáveis.
 */
export default function DetailSheet({
  article: a,
  toolTypes,
  isMobile,
  onClose,
  onToggleTag,
}) {
  const STR = useStrings();
  const { FACET_LABEL, KIND_LABEL, VERIFY_LABEL } = STR;
  const [content, setContent] = useState(null);
  const [failed, setFailed] = useState(false);
  const player = usePlayer();
  const articleId = a?.id ?? null;

  useEffect(() => {
    if (articleId == null) return undefined;
    let alive = true;
    setContent(null);
    setFailed(false);
    getContent(articleId).then(
      (c) => alive && setContent(c),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [articleId]);

  // Mantém MONTADO (open=false anima a saída dentro do Sheet); sem artigo não há o que renderizar.
  if (!a) {
    return (
      <Sheet
        open={false}
        onClose={onClose}
        isMobile={isMobile}
        overlayClassName="overlay overlay-sheet"
        panelClassName="sheet"
        headClassName="sheet-head"
      />
    );
  }

  const kind = effectiveKind(a, toolTypes);
  const title = a.title_pt || a.title || a.url;
  const excerpt = a.summary_pt || a.snippet || '';
  const isCurrent = player?.currentId === a.id;
  const paragraphs = (content || '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 400);
  const facetEntries = Object.entries(a.tags || {});

  return (
    <Sheet
      open={true}
      onClose={onClose}
      ariaLabel={title}
      isMobile={isMobile}
      overlayClassName="overlay overlay-sheet"
      panelClassName="sheet"
      headClassName="sheet-head"
      header={
        <div className="sheet-head-row">
          <span className="sheet-eyebrow">
            {a.source_name || STR.sourceFallback(a.source_id)}
            {a.date_iso ? ` · ${fmtDate(a.date_iso)}` : ''}
          </span>
          <div className="sheet-head-actions">
            {player && excerpt && (
              <PlayButton
                className="sheet-play-btn"
                active={isCurrent && player.playing}
                loading={player.loadingId === a.id}
                onClick={() =>
                  isCurrent && player.playing
                    ? player.stop()
                    : player.playOne({ id: a.id, text: excerpt, title })
                }
                playLabel={STR.playSummary}
                stopLabel={STR.stopPlayback}
              />
            )}
            <CopyButton
              value={a.url}
              variant="label"
              copiedText={STR.copiedLink}
              label={STR.copyLink}
              copiedLabel={STR.copiedLink}
            >
              {STR.copyLink}
            </CopyButton>
            <button type="button" className="icon-btn" onClick={onClose} aria-label={STR.close}>
              ✕
            </button>
          </div>
        </div>
      }
      footer={
        <div className="sheet-foot">
          {a.summary_pt && (
            <CopyButton
              value={`${title}\n\n${a.summary_pt}\n\n${a.url}`}
              variant="label"
              copiedText={STR.copiedSummary}
              label={STR.copySummary}
              copiedLabel={STR.copiedSummary}
              className="mui-copy-btn-ghost"
            >
              {STR.copySummary}
            </CopyButton>
          )}
          <ArrowLink
            className="btn btn-primary sheet-read-btn"
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            tone="primary"
            upRight={true}
          >
            {STR.readOriginal}
          </ArrowLink>
        </div>
      }
    >
      <div className="sheet-body">
        <h2 className="sheet-title">{title}</h2>
        {a.title_pt && a.title && a.title !== a.title_pt && (
          <p className="sheet-original">{a.title}</p>
        )}
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
                  {tags.map((t) =>
                    onToggleTag ? (
                      <button
                        key={t}
                        type="button"
                        className="chip"
                        title={STR.filterByTag(t)}
                        onClick={() => {
                          onToggleTag(facet, t);
                          onClose();
                        }}
                      >
                        {t}
                      </button>
                    ) : (
                      <span key={t} className="chip chip-static">
                        {t}
                      </span>
                    ),
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}
