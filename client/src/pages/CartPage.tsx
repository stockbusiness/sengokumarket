import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCart } from '../context/CartContext';

interface ValidateResponseItem {
  variantId: string;
  found: boolean;
  productSlug?: string;
  productName?: string;
  variantName?: string;
  price?: number;
  availableStock?: number;
  requestedQuantity: number;
  stockInsufficient?: boolean;
}

export default function CartPage() {
  const { items, updateQuantity, removeItem, replaceItems, totalAmount } = useCart();
  const navigate = useNavigate();
  const [notices, setNotices] = useState<string[]>([]);
  const [validating, setValidating] = useState(false);

  async function handleProceedToCheckout() {
    setValidating(true);
    setNotices([]);
    try {
      const res = await fetch('/api/cart/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
        }),
      });
      const data = await res.json();
      const resultItems: ValidateResponseItem[] = data.items ?? [];

      const newNotices: string[] = [];
      const nextItems = items
        .map((cartItem) => {
          const result = resultItems.find((r) => r.variantId === cartItem.variantId);
          if (!result || !result.found) {
            newNotices.push(`「${cartItem.productName} ${cartItem.variantName}」は現在購入できません。カートから削除しました。`);
            return null;
          }
          if (result.stockInsufficient) {
            newNotices.push(
              `「${cartItem.productName} ${cartItem.variantName}」は在庫が不足しています(残り${result.availableStock}点)。数量を調整しました。`,
            );
          }
          if (result.price !== undefined && result.price !== cartItem.price) {
            newNotices.push(`「${cartItem.productName} ${cartItem.variantName}」の価格が変更されました。`);
          }
          return {
            ...cartItem,
            price: result.price ?? cartItem.price,
            quantity: result.stockInsufficient ? Math.max(result.availableStock ?? 0, 0) : cartItem.quantity,
          };
        })
        .filter((i): i is NonNullable<typeof i> => i !== null && i.quantity > 0);

      if (newNotices.length > 0) {
        replaceItems(nextItems);
        setNotices(newNotices);
      } else {
        navigate('/checkout');
      }
    } catch {
      setNotices(['カートの確認中にエラーが発生しました。時間をおいて再度お試しください。']);
    } finally {
      setValidating(false);
    }
  }

  if (items.length === 0) {
    return <p>カートは空です。</p>;
  }

  return (
    <div className="cart-page">
      <h1>カート</h1>

      {notices.length > 0 && (
        <ul className="cart-notices">
          {notices.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

      <table>
        <tbody>
          {items.map((item) => (
            <tr key={item.variantId}>
              <td>
                {item.productName} {item.variantName}
              </td>
              <td>{item.price.toLocaleString()}円(税込)</td>
              <td>
                <input
                  type="number"
                  min={1}
                  value={item.quantity}
                  onChange={(e) => updateQuantity(item.variantId, Number(e.target.value))}
                />
              </td>
              <td>{(item.price * item.quantity).toLocaleString()}円(税込)</td>
              <td>
                <button type="button" onClick={() => removeItem(item.variantId)}>
                  削除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p>合計: {totalAmount.toLocaleString()}円(税込)</p>

      <button type="button" className="btn-primary" onClick={handleProceedToCheckout} disabled={validating}>
        {validating ? '確認中...' : '購入手続きへ進む'}
      </button>
    </div>
  );
}
