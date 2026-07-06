import { useEffect, useState } from 'react';
import { fetchAdminWalletMissing, type AdminWalletMissing } from '../../lib/adminApi';
import EmptyState from '../../components/EmptyState';

export default function AdminWalletMissingPage() {
  const [rows, setRows] = useState<AdminWalletMissing[]>([]);

  useEffect(() => {
    fetchAdminWalletMissing().then((d) => setRows(d.walletMissing));
  }, []);

  return (
    <div>
      <h1>ウォレット未登録者一覧</h1>
      {rows.length === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="ウォレット未登録の購入者はいません" />
        </div>
      ) : (
        <div className="admin-table-card">
          <table>
            <thead>
              <tr>
                <th>購入者名</th>
                <th>メールアドレス</th>
                <th>注文番号</th>
                <th>商品名</th>
                <th>購入日時</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.customerName}</td>
                  <td>{r.customerEmail}</td>
                  <td>{r.orderNumber}</td>
                  <td>{r.productName}</td>
                  <td>{new Date(r.purchasedAt).toLocaleString('ja-JP')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
