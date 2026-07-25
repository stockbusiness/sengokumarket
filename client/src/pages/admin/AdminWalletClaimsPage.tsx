import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchAdminWalletClaims, type AdminWalletClaim, type WalletClaimSearchFilters } from '../../features/admin-wallet-claims/api';
import EmptyState from '../../components/EmptyState';
import Pagination from '../../components/Pagination';

const STATUSES = ['PENDING', 'CLAIMED', 'DELIVERY_PENDING', 'DELIVERED', 'EXPIRED', 'REVOKED', 'ERROR'];

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('ja-JP') : '-';
}

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)19章「管理画面」: Wallet Claims一覧。
export default function AdminWalletClaimsPage() {
  const [claims, setClaims] = useState<AdminWalletClaim[]>([]);
  const [filters, setFilters] = useState<WalletClaimSearchFilters>({});
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  function load() {
    fetchAdminWalletClaims(page, filters).then((d) => {
      setClaims(d.walletClaims);
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
      <h1>Wallet Claims(NFTカード受取Claim)</h1>
      <p>digital_collectible対象商品の購入後に作成される、注文単位の受取Claimの状況です。</p>

      <form className="admin-search-form" onSubmit={handleSearch}>
        <label>
          注文番号
          <input
            value={filters.orderNumber ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, orderNumber: e.target.value }))}
          />
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
          <EmptyState message="該当するClaimがありません" />
        </div>
      ) : (
        <>
          <div className="admin-table-card">
            <table>
              <thead>
                <tr>
                  <th>注文番号</th>
                  <th>購入者</th>
                  <th>ステータス</th>
                  <th>送付進捗</th>
                  <th>common_user_id</th>
                  <th>有効期限</th>
                  <th>作成日時</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.id}>
                    <td>{c.orderNumber}</td>
                    <td>{c.customerName}</td>
                    <td>{c.status}</td>
                    <td>
                      {c.deliveredCount} / {c.deliveryCount}
                    </td>
                    <td>{c.commonUserId ?? '-'}</td>
                    <td>{formatDateTime(c.expiresAt)}</td>
                    <td>{formatDateTime(c.createdAt)}</td>
                    <td>
                      <Link to={`/admin/wallet-claims/${c.id}`}>詳細</Link>
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
