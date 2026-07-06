import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  fetchMyNftIssues,
  fetchMyNotices,
  fetchMyOrders,
  fetchMyWallet,
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
    fetchMyNotices().then((d) => setNotices(d.notices));
    fetchMyWallet().then((d) => setHasWallet(d.wallet !== null));
  }, []);

  return (
    <div className="mypage">
      <h1>マイページ</h1>
      {user && (
        <p>
          {user.name}さん({user.email})
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
        <ul>
          {nftIssues.map((issue) => (
            <li key={issue.id}>
              {issue.productName} {issue.variantName} - {NFT_STATUS_LABEL[issue.status] ?? issue.status}
              {issue.status === 'issued' && issue.tokenId && <> (token ID: {issue.tokenId})</>}
              {issue.status === 'failed' && <> サポートまでお問い合わせください</>}
              {issue.status === 'wallet_required' && (
                <>
                  {' '}
                  <Link to="/mypage/wallet">ウォレットを登録する</Link>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>購入履歴</h2>
        {orders.length === 0 && <p>購入履歴はありません。</p>}
        <ul>
          {orders.map((order) => (
            <li key={order.id}>
              {order.orderNumber} - {order.totalAmount.toLocaleString()}円(税込) - {order.paymentStatus}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>お知らせ</h2>
        {notices.length === 0 && <p>お知らせはありません。</p>}
        <ul>
          {notices.map((notice) => (
            <li key={notice.id}>
              <strong>{notice.title}</strong>
              <p>{notice.body}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
