import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchMyOrder, type MyOrderDetail } from '../lib/api';

function formatItemLine(item: MyOrderDetail['items'][number]): string {
  return `${item.productName}${item.variantName ? ` (${item.variantName})` : ''} × ${item.quantity}`;
}

export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const [order, setOrder] = useState<MyOrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    fetchMyOrder(id)
      .then((d) => setOrder(d.order))
      .catch((e) => setError(e instanceof Error ? e.message : '読み込みに失敗しました'));
  }, [id]);

  if (error) return <p>{error}</p>;
  if (!order) return <p>読み込み中です...</p>;

  if (order.paymentStatus !== 'paid') {
    return <p>この注文はお支払いが完了していないため、領収書を表示できません。</p>;
  }

  const issuedDate = new Date().toLocaleDateString('ja-JP');
  const paidDate = order.paidAt ? new Date(order.paidAt).toLocaleDateString('ja-JP') : '-';
  const description = order.items.map(formatItemLine).join('、');

  return (
    <div className="receipt-page">
      <div className="receipt-page__no-print">
        <button type="button" className="btn-primary" onClick={() => window.print()}>
          印刷 / PDFとして保存
        </button>
      </div>

      <div className="receipt-card">
        <h1>領収書</h1>
        <p className="receipt-card__issued-date">発行日: {issuedDate}</p>

        <p className="receipt-card__recipient">{order.customerName} 様</p>

        <p className="receipt-card__amount">
          <span>金額</span>
          <span className="receipt-card__amount-value">{order.totalAmount.toLocaleString()}円(税込)</span>
        </p>

        <p>但し、{description} として上記金額を正に領収いたしました。</p>

        <table className="legal-table">
          <tbody>
            <tr>
              <th>注文番号</th>
              <td>{order.orderNumber}</td>
            </tr>
            <tr>
              <th>お支払い日</th>
              <td>{paidDate}</td>
            </tr>
            <tr>
              <th>お支払い方法</th>
              <td>クレジットカード決済</td>
            </tr>
          </tbody>
        </table>

        <p className="receipt-card__issuer">戦国経済圏</p>
      </div>
    </div>
  );
}
