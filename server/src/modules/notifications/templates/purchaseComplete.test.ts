import { describe, expect, it } from 'vitest';
import type { Order, OrderItem } from '@prisma/client';
import { buildPurchaseCompleteEmail } from './purchaseComplete';

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    orderNumber: 'SG-20260101-0001',
    customerName: 'テスト太郎',
    customerEmail: 'test@example.com',
    totalAmount: 12000,
    ...overrides,
  } as Order;
}

function makeItem(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    productName: 'デジタル会員証',
    variantName: '通常',
    quantity: 1,
    subtotal: 12000,
    ...overrides,
  } as OrderItem;
}

describe('buildPurchaseCompleteEmail', () => {
  it('件名・本文(html/text)のスナップショット', () => {
    const message = buildPurchaseCompleteEmail(makeOrder(), [makeItem()]);
    expect(message).toMatchSnapshot();
  });

  it('顧客名にHTML特殊文字が含まれる場合、htmlではエスケープされる(XSS対策・指示書12.3)', () => {
    const message = buildPurchaseCompleteEmail(makeOrder({ customerName: '<script>alert(1)</script>' }), [makeItem()]);
    expect(message.html).not.toContain('<script>alert(1)</script>');
    expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('商品名にHTML特殊文字が含まれる場合、htmlではエスケープされる', () => {
    const message = buildPurchaseCompleteEmail(makeOrder(), [makeItem({ productName: '<img src=x onerror=alert(1)>' })]);
    expect(message.html).not.toContain('<img src=x onerror=alert(1)>');
    expect(message.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('textにはHTMLタグを含まない', () => {
    const message = buildPurchaseCompleteEmail(makeOrder(), [makeItem()]);
    expect(message.text).not.toMatch(/<[a-z]/i);
  });
});
