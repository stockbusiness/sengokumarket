import { describe, expect, it } from 'vitest';
import type { Order, OrderItem } from '@prisma/client';
import { buildCartAbandonedEmail } from './cartAbandoned';

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    orderNumber: 'SG-20260101-0001',
    customerName: 'テスト太郎',
    customerEmail: 'test@example.com',
    ...overrides,
  } as Order;
}

function makeItem(overrides: Partial<OrderItem> = {}): OrderItem {
  return { productName: 'デジタル会員証', variantName: '通常', quantity: 1, ...overrides } as OrderItem;
}

describe('buildCartAbandonedEmail', () => {
  it('件名・本文のスナップショット(productSlugあり)', () => {
    expect(buildCartAbandonedEmail(makeOrder(), [makeItem()], 'council-nft')).toMatchSnapshot();
  });

  it('productSlugがnullの場合は商品一覧ページへのリンクになる', () => {
    const message = buildCartAbandonedEmail(makeOrder(), [makeItem()], null);
    expect(message.html).toContain('/products"');
  });

  it('顧客名はhtmlでエスケープされる', () => {
    const message = buildCartAbandonedEmail(makeOrder({ customerName: '<b>x</b>' }), [makeItem()], null);
    expect(message.html).not.toContain('<b>x</b>');
    expect(message.html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
