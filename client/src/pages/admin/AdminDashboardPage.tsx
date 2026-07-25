import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchAdminDashboard, fetchAdminSalesTrend, type AdminDashboard, type SalesTrendMonth } from '../../lib/adminApi';
import { IconBadge, IconReceipt, IconWallet, IconYen } from '../../components/icons';

function formatMonthLabel(month: string): string {
  const [year, m] = month.split('-');
  return `${year}/${Number(m)}`;
}

function SalesTrendChart({ trend }: { trend: SalesTrendMonth[] }) {
  const maxSales = Math.max(...trend.map((t) => t.totalSales), 1);

  return (
    <div className="admin-sales-trend">
      {trend.map((t) => (
        <div className="admin-sales-trend__col" key={t.month}>
          <div className="admin-sales-trend__bar-track">
            <div className="admin-sales-trend__bar" style={{ height: `${(t.totalSales / maxSales) * 100}%` }} />
          </div>
          <div className="admin-sales-trend__value">{t.totalSales.toLocaleString()}円</div>
          <div className="admin-sales-trend__label">{formatMonthLabel(t.month)}</div>
        </div>
      ))}
    </div>
  );
}

export default function AdminDashboardPage() {
  const [data, setData] = useState<AdminDashboard | null>(null);
  const [trend, setTrend] = useState<SalesTrendMonth[] | null>(null);

  useEffect(() => {
    fetchAdminDashboard().then(setData);
    fetchAdminSalesTrend(6).then((d) => setTrend(d.trend));
  }, []);

  if (!data) return <p>読み込み中です...</p>;

  const alertTotal = data.alerts.partialRefundCount + data.alerts.commissionRecoveryCount;
  const integrationAlertTotal =
    data.alerts.deadNotificationCount +
    data.alerts.deadLinkingJobCount +
    data.alerts.deadIntegrationEventCount +
    data.alerts.blockedIntegrationEventCount +
    data.alerts.commonIdConflictCount;

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

      {/* 本番安定化指示書Stage11(14.3「アラート」)。 */}
      {(integrationAlertTotal > 0 || data.alerts.migrationReadinessError) && (
        <div className="admin-alert">
          <h2>外部連携・本番稼働アラート</h2>
          {data.alerts.migrationReadinessError && (
            <p>
              本番の環境変数・DB migration適用状況に問題があります(<code>/api/ready</code>を確認してください)
            </p>
          )}
          {data.alerts.deadNotificationCount > 0 && (
            <p>
              通知送信のdead件数: {data.alerts.deadNotificationCount}件(
              <Link to="/admin/notification-outbox">通知Outboxを確認</Link>)
            </p>
          )}
          {data.alerts.deadLinkingJobCount > 0 && (
            <p>
              共通ID・紹介連携ジョブのdead件数: {data.alerts.deadLinkingJobCount}件(
              <Link to="/admin/order-linking-jobs">Order Linking Jobsを確認</Link>)
            </p>
          )}
          {data.alerts.deadIntegrationEventCount > 0 && (
            <p>
              外部連携送信のdead件数: {data.alerts.deadIntegrationEventCount}件(
              <Link to="/admin/integration-outbox">Integration Outboxを確認</Link>)
            </p>
          )}
          {data.alerts.blockedIntegrationEventCount > 0 && (
            <p>
              外部連携送信の保留(blocked)件数: {data.alerts.blockedIntegrationEventCount}件(
              <Link to="/admin/integration-outbox">Integration Outboxを確認</Link>)
            </p>
          )}
          {data.alerts.commonIdConflictCount > 0 && (
            <p>
              共通ID競合件数: {data.alerts.commonIdConflictCount}件(
              <Link to="/admin/external-identity-conflicts">共通ID競合一覧を確認</Link>)
            </p>
          )}
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

      <h2>月別売上推移(直近6ヶ月)</h2>
      {trend && <SalesTrendChart trend={trend} />}

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
