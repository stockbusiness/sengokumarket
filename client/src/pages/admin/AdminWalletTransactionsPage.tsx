import { useEffect, useState } from 'react';
import {
  fetchAdminOrderWalletTransactions,
  type AdminOrderWalletTransaction,
} from '../../features/admin-order-wallet-transactions/api';
import EmptyState from '../../components/EmptyState';
import Pagination from '../../components/Pagination';

// 本番安定化指示書Stage10(13章)・Stage11(14.1「Wallet Transactions」画面)。
// grant/reversalの成功記録のみを持つ追記専用の台帳のため、再送等の操作は無い(閲覧のみ)。
export default function AdminWalletTransactionsPage() {
  const [transactions, setTransactions] = useState<AdminOrderWalletTransaction[]>([]);
  const [orderIdFilter, setOrderIdFilter] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  function load() {
    fetchAdminOrderWalletTransactions(page, orderIdFilter ? { orderId: orderIdFilter } : undefined).then((d) => {
      setTransactions(d.transactions);
      setTotal(d.total);
      setPageSize(d.pageSize);
    });
  }
  useEffect(load, [page, orderIdFilter]);

  return (
    <div>
      <h1>OVEウォレット取引履歴</h1>
      <p>OVEウォレットへのポイント付与(grant)・取消(reversal)の成功記録です。編集・削除はできません。</p>

      <label>
        注文IDで絞り込み
        <input
          type="text"
          value={orderIdFilter}
          onChange={(e) => {
            setOrderIdFilter(e.target.value);
            setPage(1);
          }}
          placeholder="order_idを入力"
        />
      </label>

      {total === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="該当する取引記録がありません" />
        </div>
      ) : (
        <>
          <div className="admin-table-card">
            <table>
              <thead>
                <tr>
                  <th>種別</th>
                  <th>金額</th>
                  <th>注文ID</th>
                  <th>注文明細ID</th>
                  <th>共通ID</th>
                  <th>ウォレット側取引ID</th>
                  <th>原付与の取引ID(取消時)</th>
                  <th>作成日時</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t) => (
                  <tr key={t.id}>
                    <td>{t.transactionType === 'grant' ? '付与' : '取消'}</td>
                    <td>{t.amount}</td>
                    <td>{t.orderId}</td>
                    <td>{t.orderItemId}</td>
                    <td>{t.commonUserId ?? '-'}</td>
                    <td>{t.walletTransactionId ?? '-'}</td>
                    <td>{t.originalWalletTransactionId ?? '-'}</td>
                    <td>{new Date(t.createdAt).toLocaleString('ja-JP')}</td>
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
