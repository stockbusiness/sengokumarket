import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  fetchAdminCollectibleDelivery,
  retryAdminCollectibleDelivery,
  type AdminCollectibleDeliveryDetail,
} from '../../features/admin-collectible-deliveries/api';
import EmptyState from '../../components/EmptyState';

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('ja-JP') : '-';
}

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)19章「管理画面」: Delivery詳細。
// 禁止事項(22章): entitlement_id変更・DELIVEREDの直接巻き戻しはこの画面では行わない
// (retryボタンはfailed/dead状態のみ表示する)。
export default function AdminCollectibleDeliveryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [delivery, setDelivery] = useState<AdminCollectibleDeliveryDetail | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    if (!id) return;
    fetchAdminCollectibleDelivery(id).then((d) => setDelivery(d.collectibleDelivery));
  }
  useEffect(load, [id]);

  async function handleRetry() {
    if (!id) return;
    setError(null);
    setMessage(null);
    try {
      const result = await retryAdminCollectibleDelivery(id);
      setMessage(`再送を実行しました(現在のステータス: ${result.status})`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '再送に失敗しました');
    }
  }

  if (!delivery) return <EmptyState message="読み込み中です" />;

  const retryable = delivery.status === 'FAILED' || delivery.status === 'DEAD';

  return (
    <div>
      <p>
        <Link to="/admin/collectible-deliveries">← Collectible Deliveries一覧へ戻る</Link>
      </p>
      <h1>Delivery詳細: {delivery.productName}</h1>

      {error && <p className="checkout-error">{error}</p>}
      {message && <p>{message}</p>}

      <div className="admin-table-card">
        <table>
          <tbody>
            <tr>
              <th>注文番号</th>
              <td>{delivery.orderNumber}</td>
            </tr>
            <tr>
              <th>シリアル番号</th>
              <td>{delivery.serialNumber ?? '-'}</td>
            </tr>
            <tr>
              <th>NftIssue ID / ステータス</th>
              <td className="admin-muted">
                {delivery.nftIssueId}(Mintステータス: {delivery.nftIssueStatus})
              </td>
            </tr>
            <tr>
              <th>entitlement_id</th>
              <td className="admin-muted">{delivery.entitlementId}</td>
            </tr>
            <tr>
              <th>ステータス</th>
              <td>{delivery.status}</td>
            </tr>
            <tr>
              <th>common_user_id</th>
              <td>{delivery.commonUserId}</td>
            </tr>
            <tr>
              <th>ove_account_id</th>
              <td>{delivery.oveAccountId}</td>
            </tr>
            <tr>
              <th>送付日時</th>
              <td>{formatDateTime(delivery.deliveredAt)}</td>
            </tr>
            <tr>
              <th>取消日時</th>
              <td>{formatDateTime(delivery.revokedAt)}</td>
            </tr>
            <tr>
              <th>最終エラー</th>
              <td>{delivery.lastError ?? '-'}</td>
            </tr>
            <tr>
              <th>Outboxステータス</th>
              <td>{delivery.outboxEventStatus ?? '-'}</td>
            </tr>
          </tbody>
        </table>
        {retryable && (
          <button type="button" className="btn-primary btn-small" onClick={handleRetry}>
            今すぐ再送
          </button>
        )}
      </div>

      <h2>送信試行履歴</h2>
      {delivery.attempts.length === 0 ? (
        <EmptyState message="まだ送信を試みていません(blocked等)" />
      ) : (
        <div className="admin-table-card">
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
              {delivery.attempts.map((a) => (
                <tr key={a.id}>
                  <td>{a.attemptNumber}</td>
                  <td>{formatDateTime(a.startedAt)}</td>
                  <td>{formatDateTime(a.finishedAt)}</td>
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
        </div>
      )}
    </div>
  );
}
