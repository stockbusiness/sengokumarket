import { describe, expect, it } from 'vitest';
import { HttpError } from '../../../lib/httpError';
import { assertStockAvailable } from './stockAvailability.policy';
import type { CheckoutVariantRow } from './checkout.types';

// DBに依存しないDomain Unit Test(指示書15.1「stock availability」)。
function row(overrides: Partial<CheckoutVariantRow> = {}): CheckoutVariantRow {
  return {
    variantId: 'variant-1',
    variantName: 'テストA',
    price: 1000,
    stock: 5,
    reservedStock: 0,
    productId: 'product-1',
    productName: 'テスト商品',
    itemType: 'physical',
    status: 'published',
    salesModel: 'direct_allowed',
    ...overrides,
  };
}

describe('assertStockAvailable', () => {
  it('在庫が足りていれば何も投げない', () => {
    const rowByVariantId = new Map([['variant-1', row({ stock: 5, reservedStock: 0 })]]);
    expect(() => assertStockAvailable([{ variantId: 'variant-1', quantity: 3 }], rowByVariantId)).not.toThrow();
  });

  it('販売可能数(stock - reservedStock)を超える数量はSTOCK_INSUFFICIENTで409', () => {
    const rowByVariantId = new Map([['variant-1', row({ stock: 5, reservedStock: 3 })]]);
    expect(() => assertStockAvailable([{ variantId: 'variant-1', quantity: 3 }], rowByVariantId)).toThrowError(
      expect.objectContaining({ status: 409, code: 'STOCK_INSUFFICIENT' } satisfies Partial<HttpError>),
    );
  });

  it('該当行が存在しない場合はPRODUCT_NOT_FOUNDで404', () => {
    const rowByVariantId = new Map<string, CheckoutVariantRow>();
    expect(() => assertStockAvailable([{ variantId: 'missing', quantity: 1 }], rowByVariantId)).toThrowError(
      expect.objectContaining({ status: 404, code: 'PRODUCT_NOT_FOUND' } satisfies Partial<HttpError>),
    );
  });

  it('status!=publishedの商品はPRODUCT_NOT_FOUNDで404(在庫があっても購入不可)', () => {
    const rowByVariantId = new Map([['variant-1', row({ status: 'draft', stock: 100 })]]);
    expect(() => assertStockAvailable([{ variantId: 'variant-1', quantity: 1 }], rowByVariantId)).toThrowError(
      expect.objectContaining({ status: 404, code: 'PRODUCT_NOT_FOUND' } satisfies Partial<HttpError>),
    );
  });
});
