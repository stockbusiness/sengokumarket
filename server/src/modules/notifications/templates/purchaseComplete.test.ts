import { describe, expect, it, vi } from 'vitest';
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
  it('件名・本文(html/text)のスナップショット', async () => {
    const message = await buildPurchaseCompleteEmail(makeOrder(), [makeItem()]);
    expect(message).toMatchSnapshot();
  });

  it('顧客名にHTML特殊文字が含まれる場合、htmlではエスケープされる(XSS対策・指示書12.3)', async () => {
    const message = await buildPurchaseCompleteEmail(makeOrder({ customerName: '<script>alert(1)</script>' }), [makeItem()]);
    expect(message.html).not.toContain('<script>alert(1)</script>');
    expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('商品名にHTML特殊文字が含まれる場合、htmlではエスケープされる', async () => {
    const message = await buildPurchaseCompleteEmail(makeOrder(), [makeItem({ productName: '<img src=x onerror=alert(1)>' })]);
    expect(message.html).not.toContain('<img src=x onerror=alert(1)>');
    expect(message.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('textにはHTMLタグを含まない', async () => {
    const message = await buildPurchaseCompleteEmail(makeOrder(), [makeItem()]);
    expect(message.text).not.toMatch(/<[a-z]/i);
  });

  it('WalletClaimトークンがある場合、受取URLが本文に含まれる(戦国マーケットNFTカード受取・送付7章)', async () => {
    const { prisma } = await import('../../../lib/prisma');
    const spy = vi.spyOn(prisma.setting, 'findUnique').mockResolvedValue({
      key: 'wallet_claim_web_base_url',
      value: (await import('../../../lib/settingsCrypto')).encryptSetting('https://wallet.example.com'),
      updatedAt: new Date(),
    } as never);
    const message = await buildPurchaseCompleteEmail(makeOrder(), [makeItem()], 'raw-claim-token');
    expect(message.html).toContain('https://wallet.example.com/claim/raw-claim-token');
    expect(message.text).toContain('https://wallet.example.com/claim/raw-claim-token');
    spy.mockRestore();
  });
});
