import { useEffect, useState } from 'react';
import { buildOrdersExportCsvUrl, fetchAdminOrders, updateAdminOrder, type AdminOrder } from '../../lib/adminApi';
import StatusBadge from '../../components/StatusBadge';
import StatusSelect from '../../components/StatusSelect';
import EmptyState from '../../components/EmptyState';

const ORDER_STATUSES = ['pending', 'paid', 'cancelled', 'refunded'];

export default function AdminOrdersPage() {
  const [orders, setOrders] = useState<AdminOrder[]>([]);

  function load() {
    fetchAdminOrders().then((d) => setOrders(d.orders));
  }
  useEffect(load, []);

  async function changeStatus(order: AdminOrder, orderStatus: string) {
    await updateAdminOrder(order.id, { orderStatus });
    load();
  }

  return (
    <div>
      <h1>注文管理</h1>
      <button
        type="button"
        className="btn-secondary btn-small"
        onClick={() => {
          window.location.href = buildOrdersExportCsvUrl();
        }}
      >
        CSV出力
      </button>
      {orders.length === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="まだ注文がありません" />
        </div>
      ) : (
        <div className="admin-table-card">
          <table>
            <thead>
              <tr>
                <th>注文番号</th>
                <th>購入者</th>
                <th>金額</th>
                <th>決済ステータス</th>
                <th>注文ステータス</th>
                <th>紹介コード</th>
                <th>代理店/紹介元</th>
                <th>報酬予定額</th>
                <th>報酬ステータス</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{o.orderNumber}</td>
                  <td>
                    {o.customerName}
                    <br />
                    {o.customerEmail}
                  </td>
                  <td>{o.totalAmount.toLocaleString()}円</td>
                  <td>
                    <StatusBadge status={o.paymentStatus} />
                  </td>
                  <td>
                    <StatusSelect value={o.orderStatus} options={ORDER_STATUSES} onChange={(v) => changeStatus(o, v)} />
                  </td>
                  <td>{o.referralCode ?? '-'}</td>
                  <td>
                    {o.agencyName ?? '-'} / {o.referrerName ?? '-'}
                  </td>
                  <td>{o.commissionAmount.toLocaleString()}円</td>
                  <td>
                    <StatusBadge status={o.commissionStatus} />
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
