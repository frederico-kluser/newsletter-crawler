/** Placeholder editorial com shimmer suave durante o boot do snapshot. */
export default function CardSkeleton() {
  return (
    <div className="card card-skeleton" aria-hidden="true">
      <div className="sk sk-eyebrow" />
      <div className="sk sk-title" />
      <div className="sk sk-title sk-short" />
      <div className="sk sk-line" />
      <div className="sk sk-line" />
      <div className="sk-tags-row">
        <div className="sk sk-tag" />
        <div className="sk sk-tag" />
      </div>
      <div className="sk sk-badge" />
    </div>
  );
}
