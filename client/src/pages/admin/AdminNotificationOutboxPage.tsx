import { useEffect, useState } from 'react';
import {
  fetchAdminNotificationOutbox,
  retryAdminNotification,
  type AdminNotificationOutboxEvent,
} from '../../features/admin-notification-outbox/api';
import { NOTIFICATION_OUTBOX_STATUSES as STATUSES } from '@sengoku/contracts';
import QueueEventTable from '../../components/QueueEventTable';
import EmptyState from '../../components/EmptyState';
import Pagination from '../../components/Pagination';

// 本番安定化指示書Stage11(14.1「Notification Outbox」画面): 代理店設定メール等の
// 送信状況をDB直接操作なしで確認・再送できるようにする。
export default function AdminNotificationOutboxPage() {
  const [events, setEvents] = useState<AdminNotificationOutboxEvent[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    fetchAdminNotificationOutbox(page, statusFilter || undefined).then((d) => {
      setEvents(d.notificationOutboxEvents);
      setTotal(d.total);
      setPageSize(d.pageSize);
    });
  }
  useEffect(load, [page, statusFilter]);

  function handleStatusFilterChange(value: string) {
    setStatusFilter(value);
    setPage(1);
  }

  async function retry(event: AdminNotificationOutboxEvent) {
    setError(null);
    setMessage(null);
    try {
      await retryAdminNotification(event.id);
      setMessage(`${event.recipient}宛の通知を再送対象にしました`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '再送の設定に失敗しました');
    }
  }

  return (
    <div>
      <h1>通知Outbox(メール送信状況)</h1>
      <p>代理店アカウント作成・アクセス権限付与等のメール送信予定・結果の一覧です。</p>

      <label>
        ステータスで絞り込み
        <select value={statusFilter} onChange={(e) => handleStatusFilterChange(e.target.value)}>
          <option value="">すべて</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      {error && <p className="checkout-error">{error}</p>}
      {message && <p>{message}</p>}

      {total === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="該当する通知データがありません" />
        </div>
      ) : (
        <>
          <div className="admin-table-card">
            <QueueEventTable
              rows={events}
              idColumnHeader="宛先・種別"
              renderIdColumn={(e) => (
                <>
                  {e.recipient}
                  <br />
                  <span className="admin-muted">{e.eventType}</span>
                </>
              )}
              onRetry={retry}
            />
          </div>
          <Pagination page={page} total={total} pageSize={pageSize} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}
