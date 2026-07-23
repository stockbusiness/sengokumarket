import type { CheckoutItemInput, CheckoutVariantRow } from './checkout.types';

// 割引前の合計金額(originalAmount)を算出する。クーポン適用の有無に関わらず、
// スナップショット対象の基準額として常に計算する。
export function calculateOriginalAmount(items: CheckoutItemInput[], rowByVariantId: Map<string, CheckoutVariantRow>): number {
  return items.reduce((sum, item) => {
    const row = rowByVariantId.get(item.variantId)!;
    return sum + row.price * item.quantity;
  }, 0);
}
