/** Placeholder do card durante o boot do snapshot (pulse por opacity em CSS puro). */
export default function CardSkeleton() {
  return (
    <div className="card card-skeleton" aria-hidden="true">
      <div className="sk sk-eyebrow" />
      <div className="sk sk-title" />
      <div className="sk sk-title sk-short" />
      <div className="sk sk-line" />
      <div className="sk sk-line" />
      <div className="sk sk-badge" />
    </div>
  );
}
