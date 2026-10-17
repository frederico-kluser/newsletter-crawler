import { motion } from 'motion/react';
import { useMemo } from 'react';
import { useMotionUITransition } from '@/components/motion-ui/ui-theme';
import {
  ArrowNudge,
  ArrowNudgeActiveProvider,
  useArrowNudgeActive,
} from '@/components/motion-ui/arrow-link';
import { useStrings } from '../i18n.jsx';
import { fmtDate } from '../lib/format.js';
import { effectiveKind } from '../lib/taxonomy.js';
import { usePlayer } from '../player.jsx';
import PlayButton from './PlayButton.jsx';

const PRIORITY_FACETS = [
  'topic-technology',
  'framework-library-tool',
  'company-vendor-model',
  'domain',
];

function extractTopTags(tagsObj, max = 3) {
  if (!tagsObj || typeof tagsObj !== 'object') return [];
  const picked = [];
  const seen = new Set();
  for (const facet of PRIORITY_FACETS) {
    for (const t of tagsObj[facet] || []) {
      if (!seen.has(t)) {
        seen.add(t);
        picked.push(t);
        if (picked.length >= max) return picked;
      }
    }
  }
  for (const list of Object.values(tagsObj)) {
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      if (!seen.has(t)) {
        seen.add(t);
        picked.push(t);
        if (picked.length >= max) return picked;
      }
    }
  }
  return picked;
}

/**
 * Card editorial do grid: eyebrow (fonte · data tabular), título com text-balance, resumo
 * com text-pretty, tags principais, badges e seta animada ArrowNudge do Motion+ UI.
 * Recebe `ref` como prop (React 19) e repassa ao motion.article (AnimatePresence popLayout).
 */
export default function ArticleCard({
  ref,
  article: a,
  toolTypes,
  onOpen,
  entryDelay = 0,
  relation = null,
}) {
  const STR = useStrings();
  const { KIND_LABEL, VERIFY_LABEL } = STR;
  const uiTransition = useMotionUITransition('ui');
  const { active, gestureProps } = useArrowNudgeActive();
  const kind = effectiveKind(a, toolTypes);
  const title = a.title_pt || a.title || a.url;
  const excerpt = a.summary_pt || a.snippet || '';
  const player = usePlayer();
  const isCurrent = player?.currentId === a.id;
  const topTags = useMemo(() => extractTopTags(a.tags, 3), [a.tags]);

  return (
    <ArrowNudgeActiveProvider active={active}>
      <motion.article
        ref={ref}
        layout
        data-article-id={a.id}
        data-kind={kind}
        className="card"
        data-playing={isCurrent || undefined}
        initial={{ opacity: 0, y: 14, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ ...uiTransition, delay: entryDelay }}
        whileHover={{ y: -3 }}
        {...gestureProps}
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
        <button
          type="button"
          className="card-hit"
          onClick={() => onOpen(a.id)}
          aria-label={`${STR.openArticle}: ${title}`}
        >
          <div className="card-eyebrow">
            <span className="card-source">{a.source_name || STR.sourceFallback(a.source_id)}</span>
            {a.date_iso && (
              <time className="card-date" dateTime={a.date_iso}>
                {fmtDate(a.date_iso)}
              </time>
            )}
          </div>

          <h3 className="card-title">{title}</h3>

          {excerpt && <p className="card-excerpt">{excerpt}</p>}

          {topTags.length > 0 && (
            <div className="card-tags" aria-hidden="true">
              {topTags.map((t) => (
                <span key={t} className="card-tag-pill">
                  #{t}
                </span>
              ))}
            </div>
          )}

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
            <span className="card-read-affordance" aria-hidden="true">
              <ArrowNudge size={13} />
            </span>
          </div>
        </button>
      </motion.article>
    </ArrowNudgeActiveProvider>
  );
}
