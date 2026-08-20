import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  fetchMyNftIssues,
  fetchMyNotices,
  fetchMyOrders,
  fetchMyWallet,
  markMyNoticeRead,
  reissueAgencyPortalAccessUrl,
  reissueWalletClaimUrl,
  submitAgencyApplication,
  type MyNftIssue,
  type MyNotice,
  type MyOrder,
} from '../lib/api';

const NFT_STATUS_LABEL: Record<string, string> = {
  wallet_required: 'ウォレット未登録',
  ready_to_issue: '発行準備中',
  processing: '発行手続き中',
  issued: '発行済み',
  failed: '発行エラー',
  cancelled: 'キャンセル済み',
};

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)7章「マイページ状態」。
const WALLET_CLAIM_STATUS_LABEL: Record<string, string> = {
  PENDING: 'NFTカードを受け取る',
  CLAIMED: '受取手続き中',
  DELIVERY_PENDING: '送付処理中',
  DELIVERED: '外部ウォレットで確認',
  EXPIRED: '受取URLを再発行',
  REVOKED: '返金・取消済み',
  ERROR: '再試行',
};
const WALLET_CLAIM_REISSUABLE = new Set(['PENDING', 'EXPIRED', 'ERROR']);

// 購入後代理店システム連携実装指示書 6.11章「マイページ」。
const AGENCY_PORTAL_STATUS_LABEL: Record<string, string> = {
  pending: '準備中',
  processing: '準備中',
  provisioned: '利用可能',
  failed: '現在準備できていません',
  blocked: '確認中です',
  revoked: '利用停止済み',
};

export default function MyPage() {
  const { user, refresh } = useAuth();
  const [orders, setOrders] = useState<MyOrder[]>([]);
  const [nftIssues, setNftIssues] = useState<MyNftIssue[]>([]);
  const [notices, setNotices] = useState<MyNotice[]>([]);
  const [hasWallet, setHasWallet] = useState<boolean | null>(null);
  const [applying, setApplying] = useState(false);
  const [applicationError, setApplicationError] = useState<string | null>(null);
  const [claimUrlByOrderId, setClaimUrlByOrderId] = useState<Record<string, string>>({});
  const [claimError, setClaimError] = useState<string | null>(null);
  const [agencyLoginUrlByOrderId, setAgencyLoginUrlByOrderId] = useState<Record<string, string>>({});
  const [agencyPortalError, setAgencyPortalError] = useState<string | null>(null);
  const [reissuingAgencyPortalOrderId, setReissuingAgencyPortalOrderId] = useState<string | null>(null);

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

  async function handleReceiveClick(orderId: string) {
    setClaimError(null);
    try {
      const { url } = await reissueWalletClaimUrl(orderId);
      setClaimUrlByOrderId((prev) => ({ ...prev, [orderId]: url }));
    } catch (e) {
      setClaimError(e instanceof Error ? e.message : '受取URLの発行に失敗しました');
    }
  }

  async function handleReissueAgencyPortalAccess(orderId: string) {
    setAgencyPortalError(null);
    setReissuingAgencyPortalOrderId(orderId);
    try {
      const { loginUrl } = await reissueAgencyPortalAccessUrl(orderId);
      setAgencyLoginUrlByOrderId((prev) => ({ ...prev, [orderId]: loginUrl }));
    } catch (e) {
      setAgencyPortalError(e instanceof Error ? e.message : 'ログインURLの再発行に失敗しました');
    } finally {
      setReissuingAgencyPortalOrderId(null);
    }
  }

  async function handleApply() {
    setApplying(true);
    setApplicationError(null);
    try {
      await submitAgencyApplication();
      await refresh();
    } catch (e) {
      setApplicationError(e instanceof Error ? e.message : '申請に失敗しました');
    } finally {
      setApplying(false);
    }
  }

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
        {claimError && <p className="mypage-error">{claimError}</p>}
        {agencyPortalError && <p className="mypage-error">{agencyPortalError}</p>}
        <ul className="order-history-list">
          {orders.map((order) => (
            <li key={order.id}>
              <span>{order.orderNumber}</span>
              <span>{order.totalAmount.toLocaleString()}円(税込)</span>
              <span>{order.paymentStatus}</span>
              {order.paymentStatus === 'paid' && <Link to={`/mypage/orders/${order.id}/receipt`}>領収書を表示</Link>}
              {order.walletClaim && (
                <span className={`wallet-claim-status wallet-claim-status--${order.walletClaim.status}`}>
                  {claimUrlByOrderId[order.id] ? (
                    <a href={claimUrlByOrderId[order.id]} target="_blank" rel="noreferrer">
                      購入したNFTカードを受け取る
                    </a>
                  ) : WALLET_CLAIM_REISSUABLE.has(order.walletClaim.status) ? (
                    <button type="button" onClick={() => handleReceiveClick(order.id)}>
                      {WALLET_CLAIM_STATUS_LABEL[order.walletClaim.status] ?? order.walletClaim.status}
                    </button>
                  ) : (
                    WALLET_CLAIM_STATUS_LABEL[order.walletClaim.status] ?? order.walletClaim.status
                  )}
                </span>
              )}
              {order.agencyPortalAccess && (
                <span className={`agency-portal-access-status agency-portal-access-status--${order.agencyPortalAccess.status}`}>
                  {order.agencyPortalAccess.status === 'provisioned' ? (
                    <>
                      <a
                        href={agencyLoginUrlByOrderId[order.id] ?? order.agencyPortalAccess.loginUrl ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                      >
                        代理店システムへログイン
                      </a>
                      <button
                        type="button"
                        className="btn-small"
                        disabled={reissuingAgencyPortalOrderId === order.id}
                        onClick={() => handleReissueAgencyPortalAccess(order.id)}
                      >
                        {reissuingAgencyPortalOrderId === order.id ? '再発行中...' : 'URLを再発行する'}
                      </button>
                    </>
                  ) : (
                    AGENCY_PORTAL_STATUS_LABEL[order.agencyPortalAccess.status] ?? order.agencyPortalAccess.status
                  )}
                </span>
              )}
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

      {user?.role === 'user' && (
        <section>
          <h2>代理店(インフルエンサー)申請</h2>
          {user.agencyApplicationSubmittedAt ? (
            <p>申請済みです。承認をお待ちください。</p>
          ) : (
            <>
              <p>紹介URLを発行して報酬を受け取る代理店(インフルエンサー)になることができます。</p>
              {applicationError && <p className="checkout-error">{applicationError}</p>}
              <button type="button" className="btn-primary" onClick={handleApply} disabled={applying}>
                {applying ? '申請中...' : '代理店になる(インフルエンサー申請)'}
              </button>
            </>
          )}
        </section>
      )}

      {user?.role === 'agency' && (
        <section>
          <h2>代理店(インフルエンサー)申請</h2>
          <p>
            既に代理店として登録されています。<Link to="/agency">代理店ポータル</Link>から紹介URLを発行できます。
          </p>
        </section>
      )}
    </div>
  );
}
