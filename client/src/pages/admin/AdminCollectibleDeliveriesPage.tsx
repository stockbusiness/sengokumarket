import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchAdminCollectibleDeliveries,
  type AdminCollectibleDelivery,
  type CollectibleDeliverySearchFilters,
} from '../../features/admin-collectible-deliveries/api';
import EmptyState from '../../components/EmptyState';
import Pagination from '../../components/Pagination';

const STATUSES = ['PENDING', 'PROCESSING', 'DELIVERED', 'REVOKED', 'FAILED', 'DEAD'];

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('ja-JP') : '-';
}

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)19章「管理画面」: Collectible
// Deliveries一覧(NftIssue単位の送付状況)。
export default function AdminCollectibleDeliveriesPage() {
  const [deliveries, setDeliveries] = useState<AdminCollectibleDelivery[]>([]);
  const [filters, setFilters] = useState<CollectibleDeliverySearchFilters>({});
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  function load() {
    fetchAdminCollectibleDeliveries(page, filters).then((d) => {
      setDeliveries(d.collectibleDeliveries);
      setTotal(d.total);
      setPageSize(d.pageSize);
    });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [page]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    load();
  }

  return (
    <div>
      <h1>Collectible Deliveries(NFTカード送付状況)</h1>
      <p>NftIssue単位(1枚=1件)のカード送付状況です。</p>

      <form className="admin-search-form" onSubmit={handleSearch}>
        <label>
          注文番号
          <input value={filters.orderNumber ?? ''} onChange={(e) => setFilters((f) => ({ ...f, orderNumber: e.target.value }))} />
        </label>
        <label>
          NftIssue ID
          <input value={filters.nftIssueId ?? ''} onChange={(e) => setFilters((f) => ({ ...f, nftIssueId: e.target.value }))} />
        </label>
        <label>
          entitlement_id
          <input value={filters.entitlementId ?? ''} onChange={(e) => setFilters((f) => ({ ...f, entitlementId: e.target.value }))} />
        </label>
        <label>
          ステータス
          <select value={filters.status ?? ''} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
            <option value="">すべて</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          common_user_id
          <input value={filters.commonUserId ?? ''} onChange={(e) => setFilters((f) => ({ ...f, commonUserId: e.target.value }))} />
        </label>
        <label>
          ove_account_id
          <input value={filters.oveAccountId ?? ''} onChange={(e) => setFilters((f) => ({ ...f, oveAccountId: e.target.value }))} />
        </label>
        <button type="submit" className="btn-secondary btn-small">
          検索
        </button>
      </form>

      {total === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="該当するDeliveryがありません" />
        </div>
      ) : (
        <>
          <div className="admin-table-card">
            <table>
              <thead>
                <tr>
                  <th>注文番号</th>
                  <th>商品</th>
                  <th>シリアル番号</th>
                  <th>ステータス</th>
                  <th>common_user_id</th>
                  <th>送付日時</th>
                  <th>作成日時</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td>{d.orderNumber}</td>
                    <td>{d.productName}</td>
                    <td>{d.serialNumber ?? '-'}</td>
                    <td>{d.status}</td>
                    <td>{d.commonUserId}</td>
                    <td>{formatDateTime(d.deliveredAt)}</td>
                    <td>{formatDateTime(d.createdAt)}</td>
                    <td>
                      <Link to={`/admin/collectible-deliveries/${d.id}`}>詳細</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} total={total} pageSize={pageSize} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}
