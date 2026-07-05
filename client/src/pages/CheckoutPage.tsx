import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCart } from '../context/CartContext';
import { getStoredReferralCode } from '../lib/referral';
import { ApiError, createCheckoutSession, resolveReferralCode } from '../lib/api';

export default function CheckoutPage() {
  const { items, totalAmount } = useCart();
  const navigate = useNavigate();

  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerPostalCode, setCustomerPostalCode] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [referrerName, setReferrerName] = useState<string | null>(null);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ orderNumber: string; totalAmount: number } | null>(null);

  useEffect(() => {
    const stored = getStoredReferralCode();
    if (stored) setReferralCode(stored);
  }, []);

  useEffect(() => {
    if (!referralCode) {
      setReferrerName(null);
      return;
    }
    let cancelled = false;
    resolveReferralCode(referralCode)
      .then((data) => {
        if (!cancelled) setReferrerName(data.found ? data.referrerName ?? null : null);
      })
      .catch(() => {
        if (!cancelled) setReferrerName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [referralCode]);

  if (items.length === 0 && !result) {
    return <p>カートが空です。</p>;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!agreedToTerms) {
      setError('利用規約・返金ポリシーへの同意が必要です');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const data = await createCheckoutSession({
        customerName,
        customerEmail,
        customerPhone,
        customerPostalCode,
        customerAddress,
        referralCode: referralCode || null,
        agreedToTerms,
        items: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
      });
      if (data.stripeCheckoutUrl) {
        window.location.href = data.stripeCheckoutUrl;
        return;
      }
      setResult({ orderNumber: data.orderNumber, totalAmount: data.totalAmount });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STOCK_INSUFFICIENT') {
        setError(`${e.message}。カートに戻って数量をご確認ください。`);
      } else if (e instanceof Error) {
        setError(e.message);
      } else {
        setError('注文の作成に失敗しました');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div className="checkout-page">
        <h1>注文を受け付けました</h1>
        <p>注文番号: {result.orderNumber}</p>
        <p>合計金額: {result.totalAmount.toLocaleString()}円(税込)</p>
        <p>決済画面への遷移に失敗しました。お手数ですがサポートまでお問い合わせください。</p>
      </div>
    );
  }

  return (
    <form className="checkout-page" onSubmit={handleSubmit}>
      <h1>購入者情報入力</h1>

      <label>
        氏名
        <input type="text" value={customerName} onChange={(e) => setCustomerName(e.target.value)} required />
      </label>

      <label>
        メールアドレス
        <input type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} required />
      </label>

      <label>
        電話番号
        <input type="tel" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} required />
      </label>

      <label>
        郵便番号
        <input type="text" value={customerPostalCode} onChange={(e) => setCustomerPostalCode(e.target.value)} required />
      </label>

      <label>
        住所
        <input type="text" value={customerAddress} onChange={(e) => setCustomerAddress(e.target.value)} required />
      </label>

      <label>
        紹介コード(任意)
        <input type="text" value={referralCode} onChange={(e) => setReferralCode(e.target.value)} />
      </label>
      {referrerName && <p>紹介元: {referrerName}</p>}

      <label>
        <input type="checkbox" checked={agreedToTerms} onChange={(e) => setAgreedToTerms(e.target.checked)} />
        <a href="/legal/terms" target="_blank" rel="noreferrer">利用規約</a>
        および
        <a href="/legal/refund" target="_blank" rel="noreferrer">返金ポリシー</a>
        に同意する
      </label>

      {error && <p className="checkout-error">{error}</p>}

      <p>合計金額: {totalAmount.toLocaleString()}円(税込)</p>

      <button type="submit" disabled={submitting}>
        {submitting ? '送信中...' : '購入を確定する'}
      </button>
      <button type="button" onClick={() => navigate('/cart')}>
        カートに戻る
      </button>
    </form>
  );
}
