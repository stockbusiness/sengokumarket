import { useEffect, useState } from 'react';
import {
  fetchAdminIntegrationOutbox,
  retryAdminIntegrationOutboxEvent,
  bulkRetryAdminIntegrationOutboxEvents,
  fetchAdminIntegrationOutboxAttempts,
  type AdminIntegrationOutboxEvent,
  type AdminIntegrationEventAttempt,
} from '../../features/admin-integration-outbox/api';
import { INTEGRATION_OUTBOX_STATUSES as STATUSES } from '@sengoku/contracts';
import QueueEventTable from '../../components/QueueEventTable';
import EmptyState from '../../components/EmptyState';
import Pagination from '../../components/Pagination';

// 本番安定化指示書Stage11(14.1「Integration Outbox」・「Integration Attempts」画面・
// 14.4「試行履歴を確認可能」)。
export default function AdminIntegrationOutboxPage() {
  const [events, setEvents] = useState<AdminIntegrationOutboxEvent[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [attemptsFor, setAttemptsFor] = useState<AdminIntegrationOutboxEvent | null>(null);
  const [attempts, setAttempts] = useState<AdminIntegrationEventAttempt[]>([]);

  function load() {
    fetchAdminIntegrationOutbox(page, statusFilter || undefined).then((d) => {
      setEvents(d.outboxEvents);
      setTotal(d.total);
      setPageSize(d.pageSize);
    });
  }
  useEffect(load, [page, statusFilter]);

  function handleStatusFilterChange(value: string) {
    setStatusFilter(value);
    setPage(1);
  }

  async function retry(event: AdminIntegrationOutboxEvent) {
    setError(null);
    setMessage(null);
    try {
      await retryAdminIntegrationOutboxEvent(event.id);
      setMessage(`${event.eventType}(${event.destinationSystemKey})を再送対象にしました`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '再送の設定に失敗しました');
    }
  }

  // 千ノ国ウォレット様からのご指摘(共通顧客HUBには登録済みだがウォレット未登録のため404となり、
  // 通常のbackoffでdeadになる件)への対応: 表示中のステータスに絞って一括再送する。
  async function bulkRetry() {
    if (!statusFilter) return;
    setError(null);
    setMessage(null);
    try {
      const result = await bulkRetryAdminIntegrationOutboxEvents(statusFilter);
      setMessage(
        `${result.attempted}件を再送しました(成功${result.succeeded}・再試行待ち${result.retrying}・保留${result.blocked}・失敗${result.dead})`,
      );
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '一括再送に失敗しました');
    }
  }

  async function showAttempts(event: AdminIntegrationOutboxEvent) {
    setAttemptsFor(event);
    const d = await fetchAdminIntegrationOutboxAttempts(event.id);
    setAttempts(d.attempts);
  }

  return (
    <div>
      <h1>Integration Outbox(外部連携送信状況)</h1>
      <p>代理店システム連携(戦国パスポート・OVEウォレット・AIアート教室)への送信状況です。</p>

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
      {statusFilter && (
        <button type="button" className="btn-secondary btn-small" onClick={bulkRetry}>
          「{statusFilter}」をまとめて再試行(最大50件)
        </button>
      )}

      {error && <p className="checkout-error">{error}</p>}
      {message && <p>{message}</p>}

      {total === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="該当する送信データがありません" />
        </div>
      ) : (
        <>
          <div className="admin-table-card">
            <QueueEventTable
              rows={events}
              idColumnHeader="種別・送信先"
              renderIdColumn={(e) => (
                <>
                  {e.eventType}
                  <br />
                  <span className="admin-muted">{e.destinationSystemKey}</span>
                </>
              )}
              onRetry={retry}
              extraActions={(e) => (
                <button type="button" className="btn-secondary btn-small" onClick={() => showAttempts(e)}>
                  試行履歴
                </button>
              )}
            />
          </div>
          <Pagination page={page} total={total} pageSize={pageSize} onPageChange={setPage} />
        </>
      )}

      {attemptsFor && (
        <div className="admin-table-card">
          <h2>
            試行履歴: {attemptsFor.eventType}({attemptsFor.destinationSystemKey})
          </h2>
          {attempts.length === 0 ? (
            <EmptyState message="このイベントはまだ送信を試みていません(blocked等)" />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>試行回数</th>
                  <th>開始</th>
                  <th>終了</th>
                  <th>結果</th>
                  <th>HTTPステータス</th>
                  <th>送信先URL</th>
                  <th>エラー・応答抜粋</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((a) => (
                  <tr key={a.id}>
                    <td>{a.attemptNumber}</td>
                    <td>{new Date(a.startedAt).toLocaleString('ja-JP')}</td>
                    <td>{a.finishedAt ? new Date(a.finishedAt).toLocaleString('ja-JP') : '-'}</td>
                    <td>{a.result}</td>
                    <td>{a.httpStatus ?? '-'}</td>
                    <td>{a.destinationUrl ?? '-'}</td>
                    <td>
                      {a.error && <p className="checkout-error">{a.error}</p>}
                      {a.responseBodyExcerpt && <p className="admin-muted">{a.responseBodyExcerpt}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
