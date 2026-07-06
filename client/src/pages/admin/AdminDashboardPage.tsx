import { useEffect, useState } from 'react';
import { fetchAdminDashboard, type AdminDashboard } from '../../lib/adminApi';
import { IconBadge, IconReceipt, IconWallet, IconYen } from '../../components/icons';

export default function AdminDashboardPage() {
  const [data, setData] = useState<AdminDashboard | null>(null);

  useEffect(() => {
    fetchAdminDashboard().then(setData);
  }, []);

  if (!data) return <p>読み込み中です...</p>;

  const alertTotal = data.alerts.partialRefundCount + data.alerts.commissionRecoveryCount;

  return (
    <div>
      <h1>管理ダッシュボード</h1>

      {alertTotal > 0 && (
        <div className="admin-alert">
          <h2>要対応アラート</h2>
          {data.alerts.partialRefundCount > 0 && <p>一部返金検知: {data.alerts.partialRefundCount}件</p>}
          {data.alerts.commissionRecoveryCount > 0 && <p>報酬要回収: {data.alerts.commissionRecoveryCount}件</p>}
        </div>
      )}

      <div className="admin-kpi-grid">
        <div className="admin-kpi admin-kpi--filled">
          <div className="admin-kpi-label">未確定報酬予定額</div>
          <div className="admin-kpi-value">{data.pendingCommissionTotal.toLocaleString()}円</div>
        </div>
        <div className="admin-kpi admin-kpi--filled">
          <div className="admin-kpi-label">要対応アラート件数</div>
          <div className="admin-kpi-value">{alertTotal}件</div>
        </div>
        <div className="admin-kpi">
          <IconYen className="admin-kpi-icon" />
          <div>
            <div className="admin-kpi-label">総売上</div>
            <div className="admin-kpi-value">{data.totalSales.toLocaleString()}円</div>
          </div>
        </div>
        <div className="admin-kpi">
          <IconReceipt className="admin-kpi-icon" />
          <div>
            <div className="admin-kpi-label">注文件数 / 決済完了件数</div>
            <div className="admin-kpi-value">
              {data.orderCount} / {data.paidCount}
            </div>
          </div>
        </div>
        <div className="admin-kpi">
          <IconBadge className="admin-kpi-icon" />
          <div>
            <div className="admin-kpi-label">NFT未発行件数</div>
            <div className="admin-kpi-value">{data.nftPendingCount}</div>
          </div>
        </div>
        <div className="admin-kpi">
          <IconWallet className="admin-kpi-icon" />
          <div>
            <div className="admin-kpi-label">ウォレット未登録件数</div>
            <div className="admin-kpi-value">{data.walletMissingCount}</div>
          </div>
        </div>
      </div>

      <div className="admin-mini-stat-band">
        <div className="admin-mini-stat">
          <span className="admin-mini-stat-label">紹介経由売上</span>
          <span className="admin-mini-stat-value">{data.referralSales.toLocaleString()}円</span>
        </div>
        {data.agencyTop5.map((a) => (
          <div className="admin-mini-stat" key={a.agencyId}>
            <span className="admin-mini-stat-label">{a.agencyName}</span>
            <span className="admin-mini-stat-value">{a.totalSales.toLocaleString()}円</span>
          </div>
        ))}
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
    </div>
  );
}
