import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchAdminWalletClaim, reissueAdminWalletClaim, type AdminWalletClaimDetail } from '../../features/admin-wallet-claims/api';
import EmptyState from '../../components/EmptyState';

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('ja-JP') : '-';
}

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)19章「管理画面」: Claim詳細。
// 禁止事項(22章): 生Token表示・entitlement_id変更・Deliveredの直接巻き戻しはこの画面では行わない。
export default function AdminWalletClaimDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [claim, setClaim] = useState<AdminWalletClaimDetail | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    if (!id) return;
    fetchAdminWalletClaim(id).then((d) => setClaim(d.walletClaim));
  }
  useEffect(load, [id]);

  async function handleReissue() {
    if (!id) return;
    setError(null);
    setMessage(null);
    try {
      const { sentTo } = await reissueAdminWalletClaim(id);
      setMessage(`受取URLを再発行し、${sentTo} へ送付しました`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '再発行に失敗しました');
    }
  }

  if (!claim) return <EmptyState message="読み込み中です" />;

  const reissuable = claim.status === 'PENDING' || claim.status === 'EXPIRED' || claim.status === 'ERROR';

  return (
    <div>
      <p>
        <Link to="/admin/wallet-claims">← Wallet Claims一覧へ戻る</Link>
      </p>
      <h1>Claim詳細: {claim.orderNumber}</h1>

      {error && <p className="checkout-error">{error}</p>}
      {message && <p>{message}</p>}

      <div className="admin-table-card">
        <table>
          <tbody>
            <tr>
              <th>購入者</th>
              <td>
                {claim.customerName}({claim.customerEmail})
              </td>
            </tr>
            <tr>
              <th>ステータス</th>
              <td>{claim.status}</td>
            </tr>
            <tr>
              <th>common_user_id</th>
              <td>{claim.commonUserId ?? '-'}</td>
            </tr>
            <tr>
              <th>ove_account_id</th>
              <td>{claim.oveAccountId ?? '-'}</td>
            </tr>
            <tr>
              <th>有効期限</th>
              <td>{formatDateTime(claim.expiresAt)}</td>
            </tr>
            <tr>
              <th>Claim確認日時</th>
              <td>{formatDateTime(claim.claimedAt)}</td>
            </tr>
            <tr>
              <th>最終エラー</th>
              <td>{claim.lastError ?? '-'}</td>
            </tr>
          </tbody>
        </table>
        {reissuable && (
          <button type="button" className="btn-primary btn-small" onClick={handleReissue}>
            受取URLを再発行(お客様へメール送付)
          </button>
        )}
      </div>

      <h2>送付状況(CollectibleDelivery)</h2>
      {claim.deliveries.length === 0 ? (
        <EmptyState message="対象のカードがありません" />
      ) : (
        <div className="admin-table-card">
          <table>
            <thead>
              <tr>
                <th>商品</th>
                <th>シリアル番号</th>
                <th>NftIssue ID</th>
                <th>entitlement_id</th>
                <th>ステータス</th>
                <th>送付日時</th>
                <th>取消日時</th>
                <th>最終エラー</th>
              </tr>
            </thead>
            <tbody>
              {claim.deliveries.map((d) => (
                <tr key={d.id}>
                  <td>{d.productName}</td>
                  <td>{d.serialNumber ?? '-'}</td>
                  <td className="admin-muted">{d.nftIssueId}</td>
                  <td className="admin-muted">{d.entitlementId}</td>
                  <td>{d.status}</td>
                  <td>{formatDateTime(d.deliveredAt)}</td>
                  <td>{formatDateTime(d.revokedAt)}</td>
                  <td>{d.lastError ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>AuditLog</h2>
      {claim.auditLogs.length === 0 ? (
        <EmptyState message="記録された監査ログはありません" />
      ) : (
        <div className="admin-table-card">
          <table>
            <thead>
              <tr>
                <th>種別</th>
                <th>詳細</th>
                <th>日時</th>
              </tr>
            </thead>
            <tbody>
              {claim.auditLogs.map((a) => (
                <tr key={a.id}>
                  <td>{a.eventType}</td>
                  <td>{a.detail ? JSON.stringify(a.detail) : '-'}</td>
                  <td>{formatDateTime(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
