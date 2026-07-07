import { useEffect, useState } from 'react';
import { fetchAgencyOrders, type AgencyOrder } from '../../lib/agencyApi';
import StatusBadge from '../../components/StatusBadge';
import EmptyState from '../../components/EmptyState';

function formatItems(items: AgencyOrder['items']) {
  return items.map((item) => `${item.productName}${item.variantName ? ` (${item.variantName})` : ''} × ${item.quantity}`).join(', ');
}

export default function AgencyOrdersPage() {
  const [orders, setOrders] = useState<AgencyOrder[]>([]);

  useEffect(() => {
    fetchAgencyOrders().then((d) => setOrders(d.orders));
  }, []);

  return (
    <div>
      <h1>紹介経由の購入者一覧</h1>
      <p>あなたの紹介URLを経由して購入したお客様の一覧です。報酬額・報酬ステータスの確認は今後対応予定です。</p>

      {orders.length === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="まだ紹介経由の購入がありません" />
        </div>
      ) : (
        <div className="admin-table-card">
          <table>
            <thead>
              <tr>
                <th>購入日時</th>
                <th>購入者名</th>
                <th>購入アイテム</th>
                <th>購入価格</th>
                <th>状況</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{new Date(o.createdAt).toLocaleString('ja-JP')}</td>
                  <td>{o.customerName}</td>
                  <td>{formatItems(o.items)}</td>
                  <td>{o.totalAmount.toLocaleString()}円</td>
                  <td>
                    <StatusBadge status={o.paymentStatus} />
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
