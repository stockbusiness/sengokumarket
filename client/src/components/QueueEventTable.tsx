import type { ReactNode } from 'react';

// 本番安定化指示書Stage11(14.1・14.2「一覧項目」): Notification Outbox・Order Linking
// Jobs・Integration Outboxはいずれも「status・attempt_count・last_error・next_attempt_at・
// created_at・processed_at・manual retry」という同じ形の一覧になるため、共通の表描画を1箇所に
// まとめる(3画面で同じマークアップを繰り返さない)。
export interface QueueEventRow {
  id: string;
  status: string;
  attemptCount: number;
  lastError: string | null;
  blockedReason?: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  processedAt: string | null;
}

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('ja-JP') : '-';
}

export default function QueueEventTable<T extends QueueEventRow>({
  rows,
  idColumnHeader,
  renderIdColumn,
  onRetry,
  retryableStatuses = ['failed', 'dead', 'blocked', 'pending'],
  extraActions,
}: {
  rows: T[];
  idColumnHeader: string;
  renderIdColumn: (row: T) => ReactNode;
  onRetry?: (row: T) => void;
  retryableStatuses?: string[];
  extraActions?: (row: T) => ReactNode;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>{idColumnHeader}</th>
          <th>ステータス</th>
          <th>試行回数</th>
          <th>最終エラー・保留理由</th>
          <th>次回再試行</th>
          <th>作成日時</th>
          <th>処理完了日時</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>{renderIdColumn(row)}</td>
            <td>{row.status}</td>
            <td>{row.attemptCount}</td>
            <td>
              {row.blockedReason && <p className="checkout-error">保留理由: {row.blockedReason}</p>}
              {row.lastError && <p className="checkout-error">{row.lastError}</p>}
              {!row.blockedReason && !row.lastError && '-'}
            </td>
            <td>{formatDateTime(row.nextAttemptAt)}</td>
            <td>{formatDateTime(row.createdAt)}</td>
            <td>{formatDateTime(row.processedAt)}</td>
            <td>
              {onRetry && retryableStatuses.includes(row.status) && (
                <button type="button" className="btn-secondary btn-small" onClick={() => onRetry(row)}>
                  今すぐ再送
                </button>
              )}
              {extraActions?.(row)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
