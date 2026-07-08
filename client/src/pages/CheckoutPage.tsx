import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCart } from '../context/CartContext';
import { getStoredReferralCode } from '../lib/referral';
import { ApiError, createCheckoutSession, fetchCheckoutConfig, resolveReferralCode } from '../lib/api';

type PaymentMethod = 'stripe' | 'bank_transfer';

interface BankTransferResult {
  orderNumber: string;
  totalAmount: number;
  bankTransferInfo: string;
  bankTransferExpiryDays: number;
}

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
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('stripe');
  const [bankTransferAvailable, setBankTransferAvailable] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ orderNumber: string; totalAmount: number } | null>(null);
  const [bankTransferResult, setBankTransferResult] = useState<BankTransferResult | null>(null);

  useEffect(() => {
    const stored = getStoredReferralCode();
    if (stored) setReferralCode(stored);
  }, []);

  useEffect(() => {
    fetchCheckoutConfig()
      .then((data) => setBankTransferAvailable(data.bankTransferAvailable))
      .catch(() => setBankTransferAvailable(false));
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

  if (items.length === 0 && !result && !bankTransferResult) {
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
        paymentMethod,
      });
      if (data.stripeCheckoutUrl) {
        window.location.href = data.stripeCheckoutUrl;
        return;
      }
      if (data.paymentMethod === 'bank_transfer' && data.bankTransferInfo) {
        setBankTransferResult({
          orderNumber: data.orderNumber,
          totalAmount: data.totalAmount,
          bankTransferInfo: data.bankTransferInfo,
          bankTransferExpiryDays: data.bankTransferExpiryDays ?? 7,
        });
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

  if (bankTransferResult) {
    return (
      <div className="checkout-page">
        <h1>お振込みのご案内</h1>
        <p>注文番号: {bankTransferResult.orderNumber}</p>
        <p>お振込み金額: {bankTransferResult.totalAmount.toLocaleString()}円(税込)</p>
        <p>
          お振込みの際は、お振込人名の前に<strong>注文番号「{bankTransferResult.orderNumber}」</strong>をご入力ください。
        </p>
        <div className="checkout-bank-transfer-info">
          {bankTransferResult.bankTransferInfo.split('\n').map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
        <p>ご注文から{bankTransferResult.bankTransferExpiryDays}日以内にお振込みください。期限を過ぎますと、ご注文は自動的にキャンセルとなります。</p>
        <p>ご案内メールも送信しておりますので、あわせてご確認ください。</p>
        <p>
          <a href="/products">商品一覧に戻る</a>
        </p>
      </div>
    );
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

      <fieldset className="checkout-payment-method">
        <legend>お支払い方法</legend>
        <label>
          <input
            type="radio"
            name="paymentMethod"
            value="stripe"
            checked={paymentMethod === 'stripe'}
            onChange={() => setPaymentMethod('stripe')}
          />
          クレジットカード決済
        </label>
        {bankTransferAvailable && (
          <label>
            <input
              type="radio"
              name="paymentMethod"
              value="bank_transfer"
              checked={paymentMethod === 'bank_transfer'}
              onChange={() => setPaymentMethod('bank_transfer')}
            />
            銀行振込
          </label>
        )}
      </fieldset>

      <label>
        <input type="checkbox" checked={agreedToTerms} onChange={(e) => setAgreedToTerms(e.target.checked)} />
        <a href="/legal/terms" target="_blank" rel="noreferrer">利用規約</a>
        および
        <a href="/legal/refund" target="_blank" rel="noreferrer">返金ポリシー</a>
        に同意する
      </label>

      {error && <p className="checkout-error">{error}</p>}

      <p>合計金額: {totalAmount.toLocaleString()}円(税込)</p>

      <button type="submit" className="btn-primary" disabled={submitting}>
        {submitting ? '送信中...' : '購入を確定する'}
      </button>
      <button type="button" className="btn-secondary" onClick={() => navigate('/cart')}>
        カートに戻る
      </button>
    </form>
  );
}
