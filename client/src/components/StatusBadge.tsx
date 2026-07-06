import { statusVariant } from '../lib/statusStyle';

export default function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge status-badge--${statusVariant(status)}`}>{status}</span>;
}
