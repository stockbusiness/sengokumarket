import { useEffect, useState } from 'react';
import {
  fetchAdminWalletMissing,
  sendAdminWalletReminder,
  deleteAdminWalletReminder,
  type AdminWalletMissing,
} from '../../lib/adminApi';
import EmptyState from '../../components/EmptyState';

export default function AdminWalletMissingPage() {
  const [rows, setRows] = useState<AdminWalletMissing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    fetchAdminWalletMissing().then((d) => setRows(d.walletMissing));
  }
  useEffect(load, []);

  async function sendReminder(row: AdminWalletMissing) {
    setError(null);
    setMessage(null);
    try {
      await sendAdminWalletReminder(row.id);
      setMessage(`${row.customerName}様へ登録案内メールを送信しました`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '案内メールの送信に失敗しました');
    }
  }

  async function deleteReminder(row: AdminWalletMissing) {
    setError(null);
    setMessage(null);
    try {
      await deleteAdminWalletReminder(row.id);
      setMessage(`${row.customerName}様の送信記録を削除しました`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '送信記録の削除に失敗しました');
    }
  }

  return (
    <div>
      <h1>ウォレット未登録者一覧</h1>

      {error && <p className="checkout-error">{error}</p>}
      {message && <p>{message}</p>}

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
                <th>最終案内メール送信日時</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.customerName}</td>
                  <td>{r.customerEmail}</td>
                  <td>{r.orderNumber}</td>
                  <td>{r.productName}</td>
                  <td>{new Date(r.purchasedAt).toLocaleString('ja-JP')}</td>
                  <td>{r.lastReminderSentAt ? new Date(r.lastReminderSentAt).toLocaleString('ja-JP') : '未送信'}</td>
                  <td>
                    <button type="button" className="btn-primary btn-small" onClick={() => sendReminder(r)}>
                      {r.lastReminderSentAt ? '案内メールを再送信' : '案内メールを送信'}
                    </button>
                    {r.lastReminderSentAt && (
                      <button type="button" className="btn-secondary btn-small" onClick={() => deleteReminder(r)}>
                        送信記録を削除
                      </button>
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
