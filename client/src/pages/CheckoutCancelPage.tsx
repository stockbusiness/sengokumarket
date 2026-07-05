import { Link } from 'react-router-dom';

export default function CheckoutCancelPage() {
  return (
    <div className="checkout-page">
      <h1>決済が完了していません</h1>
      <p>決済手続きがキャンセルされました。カートの内容は保持されています。</p>
      <p>
        <Link to="/cart">カートに戻る</Link>
      </p>
    </div>
  );
}
