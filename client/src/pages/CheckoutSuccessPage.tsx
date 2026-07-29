import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useCart } from '../context/CartContext';
import { fetchCheckoutSessionStatus } from '../lib/api';

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 60000;

export default function CheckoutSuccessPage() {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const { replaceItems } = useCart();
  const clearedRef = useRef(false);

  const [orderNumber, setOrderNumber] = useState<string | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<string | null>(null);
  const [agencyPortalStatus, setAgencyPortalStatus] = useState<string | null>(null);
  const [agencyPortalLoginUrl, setAgencyPortalLoginUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setError('セッション情報が見つかりません');
      return;
    }

    let cancelled = false;
    const startedAt = Date.now();

    async function poll() {
      try {
        const data = await fetchCheckoutSessionStatus(sessionId!);
        if (cancelled) return;
        setOrderNumber(data.orderNumber);
        setPaymentStatus(data.paymentStatus);
        setAgencyPortalStatus(data.agencyPortalAccess.status);
        setAgencyPortalLoginUrl(data.agencyPortalAccess.loginUrl);

        if (data.paymentStatus === 'paid' && !clearedRef.current) {
          clearedRef.current = true;
          replaceItems([]);
        }

        if (data.paymentStatus === 'pending' && Date.now() - startedAt < POLL_TIMEOUT_MS) {
          setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch {
        if (!cancelled) setError('注文状況の取得に失敗しました');
      }
    }

    poll();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return (
    <div className="checkout-page">
      <h1>購入手続きありがとうございます</h1>
      {orderNumber && <p>注文番号: {orderNumber}</p>}

      {paymentStatus === 'paid' && (
        <>
          <p>決済が完了しました。</p>
          <p>デジタル会員証の受け取りには、受取用ウォレットの登録が必要です。マイページから登録手続きを行ってください。</p>
        </>
      )}
      {paymentStatus === 'pending' && <p>決済情報の反映まで数分かかる場合があります。しばらくお待ちください。</p>}

      {paymentStatus === 'paid' && agencyPortalStatus === 'provisioned' && agencyPortalLoginUrl && (
        <p>
          <a href={agencyPortalLoginUrl} target="_blank" rel="noreferrer" className="btn-primary">
            代理店システムへログイン
          </a>
        </p>
      )}
      {paymentStatus === 'paid' && (agencyPortalStatus === 'pending' || agencyPortalStatus === 'processing') && (
        <p>代理店システムの準備中です。準備が整い次第、ご案内メールとマイページからログインできるようになります。</p>
      )}
      {paymentStatus === 'paid' && agencyPortalStatus === 'failed' && (
        <p>代理店システムのログイン準備が現在できていません。しばらくしてから再度お試しください。</p>
      )}
      {error && <p className="checkout-error">{error}</p>}

      <p>
        <Link to="/products">商品一覧に戻る</Link>
      </p>
    </div>
  );
}
