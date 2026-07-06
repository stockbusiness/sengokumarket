import { useEffect, useState } from 'react';
import { fetchAdminDashboard, type AdminDashboard } from '../../lib/adminApi';

export default function AdminDashboardPage() {
  const [data, setData] = useState<AdminDashboard | null>(null);

  useEffect(() => {
    fetchAdminDashboard().then(setData);
  }, []);

  if (!data) return <p>読み込み中です...</p>;

  return (
    <div>
      <h1>管理ダッシュボード</h1>

      {(data.alerts.partialRefundCount > 0 || data.alerts.commissionRecoveryCount > 0) && (
        <div className="admin-alert">
          <h2>要対応アラート</h2>
          {data.alerts.partialRefundCount > 0 && <p>一部返金検知: {data.alerts.partialRefundCount}件</p>}
          {data.alerts.commissionRecoveryCount > 0 && <p>報酬要回収: {data.alerts.commissionRecoveryCount}件</p>}
        </div>
      )}

      <div className="admin-stat-grid">
        <div className="admin-stat">
          <div className="admin-stat-label">総売上</div>
          <div className="admin-stat-value">{data.totalSales.toLocaleString()}円</div>
        </div>
        <div className="admin-stat">
          <div className="admin-stat-label">注文件数</div>
          <div className="admin-stat-value">{data.orderCount}</div>
        </div>
        <div className="admin-stat">
          <div className="admin-stat-label">決済完了件数</div>
          <div className="admin-stat-value">{data.paidCount}</div>
        </div>
        <div className="admin-stat">
          <div className="admin-stat-label">NFT未発行件数</div>
          <div className="admin-stat-value">{data.nftPendingCount}</div>
        </div>
        <div className="admin-stat">
          <div className="admin-stat-label">ウォレット未登録件数</div>
          <div className="admin-stat-value">{data.walletMissingCount}</div>
        </div>
        <div className="admin-stat">
          <div className="admin-stat-label">紹介経由売上</div>
          <div className="admin-stat-value">{data.referralSales.toLocaleString()}円</div>
        </div>
        <div className="admin-stat">
          <div className="admin-stat-label">未確定報酬予定額</div>
          <div className="admin-stat-value">{data.pendingCommissionTotal.toLocaleString()}円</div>
        </div>
      </div>

      <h2>在庫残数(バリエーション別)</h2>
      <table>
        <thead>
          <tr>
            <th>商品</th>
            <th>バリエーション</th>
            <th>在庫</th>
            <th>仮引当</th>
            <th>販売可能数</th>
          </tr>
        </thead>
        <tbody>
          {data.stockByVariant.map((v, i) => (
            <tr key={i}>
              <td>{v.productName}</td>
              <td>{v.variantName}</td>
              <td>{v.stock}</td>
              <td>{v.reservedStock}</td>
              <td>{v.availableStock}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>代理店別売上TOP5</h2>
      <ol>
        {data.agencyTop5.map((a) => (
          <li key={a.agencyId}>
            {a.agencyName}: {a.totalSales.toLocaleString()}円
          </li>
        ))}
      </ol>
    </div>
  );
}
