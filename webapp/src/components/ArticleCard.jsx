import { motion } from 'motion/react';
import { springs } from '../motion/transitions.js';
import { useStrings } from '../i18n.jsx';
import { fmtDate } from '../lib/format.js';
import { effectiveKind } from '../lib/taxonomy.js';
import { usePlayer } from '../player.jsx';
import PlayButton from './PlayButton.jsx';

/**
 * Card do grid: eyebrow (fonte · data), título PT (fallback original), resumo, badges.
 * Recebe `ref` como prop (React 19) e repassa ao motion.article — exigência do
 * AnimatePresence popLayout (o exit precisa medir/posicionar o elemento).
 */
export default function ArticleCard({ ref, article: a, toolTypes, onOpen, entryDelay = 0, relation = null }) {
  const STR = useStrings();
  const { KIND_LABEL, VERIFY_LABEL } = STR;
  const kind = effectiveKind(a, toolTypes);
  const title = a.title_pt || a.title || a.url;
  const excerpt = a.summary_pt || a.snippet || '';
  const player = usePlayer();
  const isCurrent = player?.currentId === a.id;
  return (
    <motion.article
      ref={ref}
      layout
      className="card"
      data-playing={isCurrent || undefined}
      initial={{ opacity: 0, y: 14, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ ...springs.gentle, delay: entryDelay }}
      whileHover={{ y: -3 }}
    >
      {player && excerpt && (
        <PlayButton
          className="card-play"
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
      <button type="button" className="card-hit" onClick={() => onOpen(a.id)} aria-label={`${STR.openArticle}: ${title}`}>
        <div className="card-eyebrow">
          <span className="card-source">{a.source_name || STR.sourceFallback(a.source_id)}</span>
          {a.date_iso && <time dateTime={a.date_iso}>{fmtDate(a.date_iso)}</time>}
        </div>
        <h3 className="card-title">{title}</h3>
        {excerpt && <p className="card-excerpt">{excerpt}</p>}
        <div className="card-foot">
          <span className="badge" data-kind={kind}>
            {KIND_LABEL[kind] || kind}
          </span>
          {relation && (
            <span className="badge badge-ai" data-relation={relation}>
              {relation === 'direct' ? STR.aiRelationDirect : STR.aiRelationSimilar}
            </span>
          )}
          {a.verify_status && a.verify_status !== 'ok' && (
            <span className="badge badge-verify" data-verify={a.verify_status}>
              {VERIFY_LABEL[a.verify_status] || a.verify_status}
            </span>
          )}
          {a.section && <span className="card-section">{a.section}</span>}
        </div>
      </button>
    </motion.article>
  );
}
