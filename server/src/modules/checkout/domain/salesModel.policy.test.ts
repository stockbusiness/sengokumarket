import { describe, expect, it } from 'vitest';
import { HttpError } from '../../../lib/httpError';
import { assertAgentRequiredSatisfied } from './salesModel.policy';
import type { CheckoutVariantRow } from './checkout.types';

// DBに依存しないDomain Unit Test(指示書15.1「sales model」)。
function row(overrides: Partial<CheckoutVariantRow> = {}): CheckoutVariantRow {
  return {
    variantId: 'variant-1',
    variantName: 'テストA',
    price: 1000,
    stock: 5,
    reservedStock: 0,
    productId: 'product-1',
    productName: 'テスト商品',
    itemType: 'membership',
    status: 'published',
    salesModel: 'agent_required',
    ...overrides,
  };
}

describe('assertAgentRequiredSatisfied', () => {
  it('agent_requiredの商品で代理店・インフルエンサーどちらも未確定ならAGENT_REQUIREDで400', () => {
    const rowByVariantId = new Map([['variant-1', row()]]);
    expect(() =>
      assertAgentRequiredSatisfied([{ variantId: 'variant-1', quantity: 1 }], rowByVariantId, { agencyId: null, influencerId: null }),
    ).toThrowError(expect.objectContaining({ status: 400, code: 'AGENT_REQUIRED' } satisfies Partial<HttpError>));
  });

  it('agencyIdが確定していれば購入できる', () => {
    const rowByVariantId = new Map([['variant-1', row()]]);
    expect(() =>
      assertAgentRequiredSatisfied([{ variantId: 'variant-1', quantity: 1 }], rowByVariantId, { agencyId: 'agency-1', influencerId: null }),
    ).not.toThrow();
  });

  it('influencerIdのみでも(代理店経由のアドバイザー)購入できる', () => {
    const rowByVariantId = new Map([['variant-1', row()]]);
    expect(() =>
      assertAgentRequiredSatisfied([{ variantId: 'variant-1', quantity: 1 }], rowByVariantId, { agencyId: null, influencerId: 'inf-1' }),
    ).not.toThrow();
  });

  it('sales_model=direct_allowedの商品は代理店未確定でも購入できる', () => {
    const rowByVariantId = new Map([['variant-1', row({ salesModel: 'direct_allowed' })]]);
    expect(() =>
      assertAgentRequiredSatisfied([{ variantId: 'variant-1', quantity: 1 }], rowByVariantId, { agencyId: null, influencerId: null }),
    ).not.toThrow();
  });
});
