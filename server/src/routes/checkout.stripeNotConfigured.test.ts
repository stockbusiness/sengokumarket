import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { referralCookieHeader } from '../test/referralCookie';

// Stripe未設定(settingsテーブルにstripe_secret_keyが無い)状態で
// 実際にcreateStripeCheckoutSessionを呼び出し、失敗時に在庫の仮引当が
// 補償ロールバックされることを検証する(モックを使わない結合テスト)。
const app = createApp();

describe('POST /api/checkout/create-session (Stripe未設定)', () => {
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    await prisma.setting.deleteMany({ where: { key: { in: ['stripe_secret_key', 'stripe_webhook_secret'] } } });

    const product = await prisma.product.create({
      data: {
        name: 'テスト商品(未設定)',
        slug: `test-noconfig-product-${Date.now()}`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 5000,
        status: 'published',
      },
    });
    productId = product.id;

    const variant = await prisma.productVariant.create({
      data: { productId, name: 'テストA', price: 5000, stock: 3, reservedStock: 0 },
    });
    variantId = variant.id;
  });

  afterAll(async () => {
    await prisma.orderItem.deleteMany({ where: { productId } });
    await prisma.order.deleteMany({ where: { customerEmail: { contains: 'noconfig-test' } } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.user.deleteMany({ where: { email: { contains: 'noconfig-test' } } });
    await prisma.$disconnect();
  });

  it('STRIPE_NOT_CONFIGUREDエラーになり、仮引当した在庫が解放され注文はfailedになる', async () => {
    const email = `noconfig-test-${Date.now()}@example.com`;
    const res = await request(app)
      .post('/api/checkout/create-session')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', referralCookieHeader())
      .send({
        customerName: 'テスト太郎',
        customerEmail: email,
        customerPhone: '090-1234-5678',
        customerPostalCode: '100-0001',
        customerAddress: '東京都千代田区1-1-1',
        agreedToTerms: true,
        items: [{ variantId, quantity: 1 }],
      });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('STRIPE_NOT_CONFIGURED');

    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
    expect(variant.reservedStock).toBe(0);

    const order = await prisma.order.findFirstOrThrow({ where: { customerEmail: email } });
    expect(order.paymentStatus).toBe('failed');
  });
});
