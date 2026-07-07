import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  fetchMyNftIssues,
  fetchMyNotices,
  fetchMyOrders,
  fetchMyWallet,
  markMyNoticeRead,
  type MyNftIssue,
  type MyNotice,
  type MyOrder,
} from '../lib/api';

const NFT_STATUS_LABEL: Record<string, string> = {
  wallet_required: 'ウォレット未登録',
  ready_to_issue: '発行準備中',
  issued: '発行済み',
  failed: '発行エラー',
  cancelled: 'キャンセル済み',
};

export default function MyPage() {
  const { user } = useAuth();
  const [orders, setOrders] = useState<MyOrder[]>([]);
  const [nftIssues, setNftIssues] = useState<MyNftIssue[]>([]);
  const [notices, setNotices] = useState<MyNotice[]>([]);
  const [hasWallet, setHasWallet] = useState<boolean | null>(null);

  useEffect(() => {
    fetchMyOrders().then((d) => setOrders(d.orders));
    fetchMyNftIssues().then((d) => setNftIssues(d.nftIssues));
    fetchMyNotices().then((d) => {
      setNotices(d.notices);
      // 表示した時点で既読化する(次回訪問時から「NEW」表示が外れる)
      d.notices.filter((n) => !n.read).forEach((n) => markMyNoticeRead(n.id).catch(() => {}));
    });
    fetchMyWallet().then((d) => setHasWallet(d.wallet !== null));
  }, []);

  return (
    <div className="mypage">
      <h1>マイページ</h1>
      {user && (
        <p>
          {user.name}さん({user.email}) <Link to="/mypage/profile">登録情報を編集する</Link>
        </p>
      )}

      {hasWallet === false && (
        <div className="mypage-banner">
          <p>受取用ウォレットが未登録です。デジタル会員証を受け取るには登録が必要です。</p>
          <Link to="/mypage/wallet">ウォレットを登録する</Link>
        </div>
      )}

      <section>
        <h2>デジタル会員証の発行状況</h2>
        {nftIssues.length === 0 && <p>対象のデジタル会員証はありません。</p>}
        <ul className="nft-status-list">
          {nftIssues.map((issue) => (
            <li key={issue.id} className={`nft-status-card nft-status-card--${issue.status}`}>
              <div className="nft-status-card__name">
                {issue.productName} {issue.variantName}
              </div>
              <div className="nft-status-card__status">{NFT_STATUS_LABEL[issue.status] ?? issue.status}</div>
              {issue.status === 'issued' && issue.tokenId && (
                <div className="nft-status-card__meta">token ID: {issue.tokenId}</div>
              )}
              {issue.status === 'failed' && <div className="nft-status-card__meta">サポートまでお問い合わせください</div>}
              {issue.status === 'wallet_required' && (
                <div className="nft-status-card__meta">
                  <Link to="/mypage/wallet">ウォレットを登録する</Link>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>購入履歴</h2>
        {orders.length === 0 && <p>購入履歴はありません。</p>}
        <ul className="order-history-list">
          {orders.map((order) => (
            <li key={order.id}>
              <span>{order.orderNumber}</span>
              <span>{order.totalAmount.toLocaleString()}円(税込)</span>
              <span>{order.paymentStatus}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>お知らせ</h2>
        {notices.length === 0 && <p>お知らせはありません。</p>}
        <ul className="notice-list">
          {notices.map((notice) => (
            <li key={notice.id}>
              <strong>
                {notice.title}
                {!notice.read && <span className="notice-badge-new">NEW</span>}
              </strong>
              <p>{notice.body}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
