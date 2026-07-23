import type { Prisma } from '@prisma/client';
import type { CheckoutItemInput, CheckoutVariantRow } from '../domain/checkout.types';

type Tx = Prisma.TransactionClient;

interface RawVariantRow {
  variant_id: string;
  variant_name: string;
  price: number;
  stock: number;
  reserved_stock: number;
  product_id: string;
  product_name: string;
  item_type: string;
  status: string;
  sales_model: string;
}

function toCheckoutVariantRow(row: RawVariantRow): CheckoutVariantRow {
  return {
    variantId: row.variant_id,
    variantName: row.variant_name,
    price: row.price,
    stock: row.stock,
    reservedStock: row.reserved_stock,
    productId: row.product_id,
    productName: row.product_name,
    itemType: row.item_type,
    status: row.status,
    salesModel: row.sales_model,
  };
}

// FOR UPDATEでの行ロックはオーバーセル防止の要(指示書3.2「Checkout時の行ロック」変更禁止)。
// ロック順序を揃えてデッドロックを防ぐため、呼び出し側でsortedVariantIdsを渡すこと。
export async function lockVariantsForCheckout(tx: Tx, sortedVariantIds: string[]): Promise<Map<string, CheckoutVariantRow>> {
  const rows = await tx.$queryRaw<RawVariantRow[]>`
    SELECT
      pv.id AS variant_id,
      pv.name AS variant_name,
      pv.price AS price,
      pv.stock AS stock,
      pv.reserved_stock AS reserved_stock,
      p.id AS product_id,
      p.name AS product_name,
      p.item_type AS item_type,
      p.status AS status,
      p.sales_model AS sales_model
    FROM product_variants pv
    JOIN products p ON p.id = pv.product_id
    WHERE pv.id = ANY(${sortedVariantIds}::uuid[])
    ORDER BY pv.id
    FOR UPDATE OF pv
  `;
  return new Map(rows.map((r) => [r.variant_id, toCheckoutVariantRow(r)]));
}

// 在庫の仮引当(指示書3.2「仮引当」)。入力配列をそのまま辿るため、同一variantIdが
// 複数明細に分かれていても各明細の数量分だけ加算される(既存挙動を維持)。
export async function reserveStock(tx: Tx, items: CheckoutItemInput[]): Promise<void> {
  for (const item of items) {
    await tx.productVariant.update({
      where: { id: item.variantId },
      data: { reservedStock: { increment: item.quantity } },
    });
  }
}

// 仮引当の解放(指示書3.2「期限切れ時の仮引当解放」)。
export async function releaseStock(tx: Tx, items: CheckoutItemInput[]): Promise<void> {
  for (const item of items) {
    await tx.productVariant.update({
      where: { id: item.variantId },
      data: { reservedStock: { decrement: item.quantity } },
    });
  }
}
