import { HttpError } from '../../../lib/httpError';
import type { CheckoutItemInput, CheckoutVariantRow } from './checkout.types';

// 各行のFOR UPDATE取得結果と要求数量を突き合わせ、公開状態・在庫可否を検証する。
// 販売可能数 = stock - reserved_stock(指示書3.2「オーバーセル防止」・変更禁止)。
// Prisma・Expressに依存しない純粋なPolicyとし、行データは呼び出し側(usecase)から渡す。
export function assertStockAvailable(items: CheckoutItemInput[], rowByVariantId: Map<string, CheckoutVariantRow>): void {
  for (const item of items) {
    const row = rowByVariantId.get(item.variantId);
    if (!row || row.status !== 'published') {
      throw new HttpError(404, 'PRODUCT_NOT_FOUND', '商品が見つかりません');
    }
    const availableStock = row.stock - row.reservedStock;
    if (availableStock < item.quantity) {
      throw new HttpError(409, 'STOCK_INSUFFICIENT', `「${row.productName} ${row.variantName}」の在庫が不足しています`);
    }
  }
}
