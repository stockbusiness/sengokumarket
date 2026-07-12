import { useEffect, useState } from 'react';
import {
  buildOrdersExportCsvUrl,
  confirmBankTransferPayment,
  fetchAdminOrders,
  updateAdminOrder,
  type AdminOrder,
} from '../../lib/adminApi';
import StatusBadge from '../../components/StatusBadge';
import StatusSelect from '../../components/StatusSelect';
import EmptyState from '../../components/EmptyState';

const ORDER_STATUSES = ['pending', 'paid', 'cancelled', 'refunded'];

type StatusMessage = { type: 'success' | 'error'; text: string };

export default function AdminOrdersPage() {
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);

  function load() {
    fetchAdminOrders().then((d) => setOrders(d.orders));
  }
  useEffect(load, []);

  function notify(type: StatusMessage['type'], text: string) {
    setStatusMessage({ type, text });
    setTimeout(() => setStatusMessage((cur) => (cur?.text === text ? null : cur)), 4000);
  }

  async function changeStatus(order: AdminOrder, orderStatus: string) {
    await updateAdminOrder(order.id, { orderStatus });
    load();
  }

  async function handleConfirmBankTransfer(order: AdminOrder) {
    if (!window.confirm(`注文番号 ${order.orderNumber} の入金を確認しましたか？\nこの操作は取り消せません。`)) return;
    await confirmBankTransferPayment(order.id);
    load();
  }

  // 説明責任者は紹介コードとは独立して後から入力・修正できる(注文ごとに担当が変わりうるため)。
  // 名簿と一致すればexplainerMatchedがtrueになって返るので、その旨を表示する。
  async function handleUpdateExplainerName(order: AdminOrder, explainerName: string) {
    if (explainerName === (order.explainerName ?? '')) return;
    try {
      await updateAdminOrder(order.id, { explainerName });
      notify('success', `注文番号 ${order.orderNumber} の説明責任者を更新しました`);
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : '説明責任者の更新に失敗しました');
    }
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
      {statusMessage && (
        <p className={statusMessage.type === 'success' ? 'checkout-success' : 'checkout-error'}>{statusMessage.text}</p>
      )}
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
                <th>決済方法</th>
                <th>決済ステータス</th>
                <th>注文ステータス</th>
                <th>紹介コード</th>
                <th>代理店/紹介元</th>
                <th>代理店階層(参考)</th>
                <th>報酬予定額</th>
                <th>報酬ステータス</th>
                <th>説明責任者</th>
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
                  <td>{o.paymentMethod === 'bank_transfer' ? '銀行振込' : 'クレジットカード'}</td>
                  <td>
                    <StatusBadge status={o.paymentStatus} />
                    {o.paymentMethod === 'bank_transfer' && o.paymentStatus === 'pending' && (
                      <>
                        <br />
                        <button type="button" className="btn-primary btn-small" onClick={() => handleConfirmBankTransfer(o)}>
                          入金確認
                        </button>
                      </>
                    )}
                  </td>
                  <td>
                    <StatusSelect value={o.orderStatus} options={ORDER_STATUSES} onChange={(v) => changeStatus(o, v)} />
                  </td>
                  <td>{o.referralCode ?? '-'}</td>
                  <td>
                    {o.agencyName ?? '-'} / {o.referrerName ?? '-'}
                  </td>
                  <td>
                    {o.referralHierarchy && o.referralHierarchy.length > 0
                      ? o.referralHierarchy
                          .slice()
                          .sort((a, b) => a.depth - b.depth)
                          .map((n) => n.name)
                          .join(' ← ')
                      : '-'}
                  </td>
                  <td>{o.commissionAmount.toLocaleString()}円</td>
                  <td>
                    <StatusBadge status={o.commissionStatus} />
                  </td>
                  <td>
                    <input
                      type="text"
                      className="admin-explainer-input"
                      defaultValue={o.explainerName ?? ''}
                      placeholder="説明担当者のお名前"
                      onBlur={(e) => handleUpdateExplainerName(o, e.target.value.trim())}
                    />
                    {o.explainerName && (
                      <p className="admin-explainer-status">
                        {o.explainerMatched ? `→ 「${o.explainerName}」と一致` : '→ 名簿に一致なし(未登録)'}
                      </p>
                    )}
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
