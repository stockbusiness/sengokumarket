import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCart } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';
import { getStoredReferralCode } from '../lib/referral';
import { ApiError, createCheckoutSession, fetchCheckoutConfig, resolveReferralCode, validateCoupon, type CouponValidationResult } from '../lib/api';

type PaymentMethod = 'stripe' | 'bank_transfer';

interface BankTransferResult {
  orderNumber: string;
  totalAmount: number;
  bankTransferInfo: string;
  bankTransferExpiryDays: number;
}

export default function CheckoutPage() {
  const { items, totalAmount } = useCart();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerPostalCode, setCustomerPostalCode] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [referrerName, setReferrerName] = useState<string | null>(null);
  const [autoApplyCouponCode, setAutoApplyCouponCode] = useState<string | null>(null);
  const [manualCouponCode, setManualCouponCode] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState<CouponValidationResult | null>(null);
  const [couponSource, setCouponSource] = useState<'auto' | 'manual' | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [couponChecking, setCouponChecking] = useState(false);
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

  // ログイン中はマイページの氏名・メール・電話番号を初期値として自動入力する
  // (郵便番号・住所はプロフィールに保存されていないため対象外)。あくまで初期値なので
  // 引き続き編集は可能。
  useEffect(() => {
    if (!user) return;
    setCustomerName((prev) => prev || user.name);
    setCustomerEmail((prev) => prev || user.email);
    setCustomerPhone((prev) => prev || user.phone || '');
  }, [user]);

  useEffect(() => {
    fetchCheckoutConfig()
      .then((data) => setBankTransferAvailable(data.bankTransferAvailable))
      .catch(() => setBankTransferAvailable(false));
  }, []);

  useEffect(() => {
    if (!referralCode) {
      setReferrerName(null);
      setAutoApplyCouponCode(null);
      return;
    }
    let cancelled = false;
    resolveReferralCode(referralCode)
      .then((data) => {
        if (cancelled) return;
        setReferrerName(data.found ? data.referrerName ?? null : null);
        setAutoApplyCouponCode(data.found ? data.autoApplyCouponCode ?? null : null);
      })
      .catch(() => {
        if (!cancelled) {
          setReferrerName(null);
          setAutoApplyCouponCode(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [referralCode]);

  // 仕様書外の拡張(クーポン機能): 紹介URLに自動適用クーポンが設定されている場合、
  // 購入画面を開いた時点でプレビューを表示する(仕様書8.1)。
  useEffect(() => {
    if (!autoApplyCouponCode || items.length === 0) {
      return;
    }
    let cancelled = false;
    validateCoupon(
      autoApplyCouponCode,
      referralCode || null,
      items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
    )
      .then((data) => {
        if (!cancelled && data.valid) {
          setAppliedCoupon(data);
          setCouponSource('auto');
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoApplyCouponCode]);

  async function handleApplyCoupon() {
    if (!manualCouponCode.trim()) return;
    setCouponChecking(true);
    setCouponError(null);
    try {
      const data = await validateCoupon(
        manualCouponCode.trim(),
        referralCode || null,
        items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
      );
      if (data.valid) {
        setAppliedCoupon(data);
        setCouponSource('manual');
      } else {
        setCouponError(data.message ?? 'クーポンを適用できませんでした');
      }
    } catch (e) {
      setCouponError(e instanceof Error ? e.message : 'クーポンを適用できませんでした');
    } finally {
      setCouponChecking(false);
    }
  }

  // 手入力で適用したクーポンのみ削除できる。購入URLに固定された自動適用クーポンは
  // 購入者側では解除できない(仕様書8.5)。
  function handleRemoveCoupon() {
    setAppliedCoupon(null);
    setCouponSource(null);
    setManualCouponCode('');
    setCouponError(null);
  }

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
        // 自動適用クーポンはサーバー側の紹介リンク解決に任せる(失敗時は購入を止めず通常価格で継続)。
        // ここで送るのは購入者が自分でコードを入力・適用した場合のみ(失敗時は購入を中断させる)。
        couponCode: couponSource === 'manual' ? (appliedCoupon?.coupon?.code ?? null) : null,
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

      {appliedCoupon?.valid && (
        <div className="checkout-coupon-applied">
          <p>
            クーポンが適用されました。
            <br />
            {appliedCoupon.coupon?.name}
          </p>
          {couponSource === 'manual' && (
            <button type="button" className="btn-small" onClick={handleRemoveCoupon}>
              クーポンを削除する
            </button>
          )}
        </div>
      )}

      {!appliedCoupon?.valid && !autoApplyCouponCode && (
        <label>
          クーポンコード(任意)
          <div className="checkout-coupon-input">
            <input type="text" value={manualCouponCode} onChange={(e) => setManualCouponCode(e.target.value)} />
            <button type="button" className="btn-secondary" onClick={handleApplyCoupon} disabled={couponChecking || !manualCouponCode.trim()}>
              {couponChecking ? '確認中...' : '適用する'}
            </button>
          </div>
        </label>
      )}
      {couponError && <p className="checkout-error">{couponError}</p>}

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

      {appliedCoupon?.valid && appliedCoupon.pricing ? (
        <div className="checkout-price-summary">
          <p>商品価格: {appliedCoupon.pricing.originalAmount.toLocaleString()}円(税込)</p>
          <p>
            {appliedCoupon.coupon?.name}: -{appliedCoupon.pricing.discountAmount.toLocaleString()}円
          </p>
          <p>お支払い金額: {appliedCoupon.pricing.finalAmount.toLocaleString()}円(税込)</p>
        </div>
      ) : (
        <p>合計金額: {totalAmount.toLocaleString()}円(税込)</p>
      )}

      <button type="submit" className="btn-primary" disabled={submitting}>
        {submitting ? '送信中...' : '購入を確定する'}
      </button>
      <button type="button" className="btn-secondary" onClick={() => navigate('/cart')}>
        カートに戻る
      </button>
    </form>
  );
}
