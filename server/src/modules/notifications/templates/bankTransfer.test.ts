import { describe, expect, it } from 'vitest';
import type { Order, OrderItem } from '@prisma/client';
import { buildBankTransferInstructionsEmail } from './bankTransfer';

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
  return { productName: 'デジタル会員証', variantName: '通常', quantity: 1, subtotal: 12000, ...overrides } as OrderItem;
}

describe('buildBankTransferInstructionsEmail', () => {
  it('件名・本文のスナップショット', () => {
    const message = buildBankTransferInstructionsEmail(makeOrder(), [makeItem()], '銀行名: テスト銀行\n支店名: 本店\n口座番号: 1234567', 7);
    expect(message).toMatchSnapshot();
  });

  it('銀行情報にHTML特殊文字が含まれる場合、htmlではエスケープされる(指示書12.3)', () => {
    const message = buildBankTransferInstructionsEmail(makeOrder(), [makeItem()], '銀行名: A&B<script>alert(1)</script>銀行', 7);
    expect(message.html).not.toContain('<script>alert(1)</script>');
    expect(message.html).toContain('A&amp;B&lt;script&gt;alert(1)&lt;/script&gt;銀行');
  });

  it('顧客名はhtmlでエスケープされる', () => {
    const message = buildBankTransferInstructionsEmail(makeOrder({ customerName: '<b>x</b>' }), [makeItem()], '銀行名: テスト銀行', 7);
    expect(message.html).not.toContain('<b>x</b>');
  });
});
