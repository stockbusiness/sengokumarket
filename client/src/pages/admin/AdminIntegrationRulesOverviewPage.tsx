import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchAdminProductIntegrationRulesOverview,
  type AdminProductIntegrationRuleWithProduct,
} from '../../features/admin-integration-rules-overview/api';
import EmptyState from '../../components/EmptyState';

// 本番安定化指示書Stage6(9.5)・Stage11(14.1「Product Integration Rules」画面): 全商品横断の
// 連携ルール一覧。編集は商品編集画面(/admin/products/:id/edit)で行う(ここは閲覧のみ)。
export default function AdminIntegrationRulesOverviewPage() {
  const [rules, setRules] = useState<AdminProductIntegrationRuleWithProduct[]>([]);

  useEffect(() => {
    fetchAdminProductIntegrationRulesOverview().then((d) => setRules(d.rules));
  }, []);

  return (
    <div>
      <h1>商品連携ルール一覧(千ノ国連携)</h1>
      <p>各商品に設定されている外部連携先(戦国パスポート・OVEウォレット・AIアート教室)へのルーティング設定の一覧です。</p>

      {rules.length === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="連携ルールが設定された商品はありません" />
        </div>
      ) : (
        <div className="admin-table-card">
          <table>
            <thead>
              <tr>
                <th>商品</th>
                <th>送信先</th>
                <th>権利種別</th>
                <th>OVEポイント</th>
                <th>返金時取消</th>
                <th>有効</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>{r.product.name}</td>
                  <td>{r.entitlementTargetSystemKey ?? '-'}</td>
                  <td>{r.entitlementType ?? '-'}</td>
                  <td>
                    {r.rewardAmountPerUnit ?? '-'}
                    {r.rewardCalculationMode && <span className="admin-muted"> ({r.rewardCalculationMode})</span>}
                  </td>
                  <td>{r.revokeOnRefund ? 'する' : 'しない'}</td>
                  <td>{r.enabled ? '有効' : '無効'}</td>
                  <td>
                    <Link to={`/admin/products/${r.product.id}/edit`} className="btn-secondary btn-small">
                      商品編集画面へ
                    </Link>
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
