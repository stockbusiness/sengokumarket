export default function EmptyState({
  message,
  actionLabel,
  onAction,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="admin-empty-state">
      <p>{message}</p>
      {actionLabel && onAction && (
        <button type="button" className="btn-primary btn-small" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
