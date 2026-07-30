import { useEffect, useState } from 'react';
import {
  fetchAdminWalletMissing,
  sendAdminWalletReminder,
  deleteAdminWalletReminder,
  createAdminWalletRegistrationLink,
  revokeAdminWalletRegistrationLink,
  type AdminWalletMissing,
} from '../../lib/adminApi';
import EmptyState from '../../components/EmptyState';

const LINK_STATUS_LABEL: Record<AdminWalletMissing['linkStatus'], string> = {
  none: '未発行',
  active: '有効',
  used: '使用済み',
  expired: '期限切れ',
  revoked: '失効済み',
};

export default function AdminWalletMissingPage() {
  const [rows, setRows] = useState<AdminWalletMissing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [issuedUrl, setIssuedUrl] = useState<{ userId: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

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

  // 仕様書外の拡張: ウォレットアドレス自体の直接入力・登録は署名検証を迂回するため行わず、
  // 「本人専用の登録用URL」の発行(初回発行・再発行を兼ねる)・失効のみ管理画面から行う。
  async function issueLink(row: AdminWalletMissing) {
    if (!row.userId) return;
    setError(null);
    setMessage(null);
    setIssuedUrl(null);
    setCopied(false);
    try {
      const { url } = await createAdminWalletRegistrationLink(row.userId);
      setIssuedUrl({ userId: row.userId, url });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '登録用リンクの発行に失敗しました');
    }
  }

  async function revokeLink(row: AdminWalletMissing) {
    if (!row.userId) return;
    setError(null);
    setMessage(null);
    try {
      await revokeAdminWalletRegistrationLink(row.userId);
      setMessage(`${row.customerName}様の登録用リンクを失効させました`);
      if (issuedUrl?.userId === row.userId) setIssuedUrl(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '登録用リンクの失効に失敗しました');
    }
  }

  async function copyUrl(url: string) {
    await navigator.clipboard.writeText(url);
    setCopied(true);
  }

  return (
    <div>
      <h1>ウォレット未登録者一覧</h1>

      {error && <p className="checkout-error">{error}</p>}
      {message && <p>{message}</p>}

      {issuedUrl && (
        <div className="referral-links-result">
          <p>登録用リンクを発行しました。本人へ既存の連絡手段(メール・LINE等)で共有してください。</p>
          <p className="referral-links-url">{issuedUrl.url}</p>
          <button type="button" className="btn-small" onClick={() => copyUrl(issuedUrl.url)}>
            {copied ? 'コピーしました' : 'URLをコピー'}
          </button>
        </div>
      )}

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
                <th>登録用リンク(仕様書外の拡張)</th>
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
                    {LINK_STATUS_LABEL[r.linkStatus]}
                    {r.linkStatus === 'active' && r.linkExpiresAt && (
                      <> (期限: {new Date(r.linkExpiresAt).toLocaleDateString('ja-JP')})</>
                    )}
                  </td>
                  <td>
                    <button type="button" className="btn-primary btn-small" onClick={() => sendReminder(r)}>
                      {r.lastReminderSentAt ? '案内メールを再送信' : '案内メールを送信'}
                    </button>
                    {r.lastReminderSentAt && (
                      <button type="button" className="btn-secondary btn-small" onClick={() => deleteReminder(r)}>
                        送信記録を削除
                      </button>
                    )}
                    {r.userId && r.linkStatus !== 'used' && (
                      <>
                        <button type="button" className="btn-secondary btn-small" onClick={() => issueLink(r)}>
                          {r.linkStatus === 'active' ? '登録用リンクを再発行する' : '登録用リンクを発行する'}
                        </button>
                        {r.linkStatus === 'active' && (
                          <button type="button" className="btn-secondary btn-small" onClick={() => revokeLink(r)}>
                            登録用リンクを失効させる
                          </button>
                        )}
                      </>
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
