import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { referralCookieHeader } from '../test/referralCookie';

// このテストファイルでは注文作成の業務ロジックのみを検証する。
// 実際のStripe API呼び出しはネットワーク/実キーが必要なため、成功を返すダミー実装に差し替える。
vi.mock('../services/stripeCheckout', () => ({
  createStripeCheckoutSession: vi.fn(async () => ({
    id: `cs_test_${Math.random().toString(36).slice(2)}`,
    url: 'https://checkout.stripe.com/test-session',
  })),
}));

const app = createApp();

describe('POST /api/checkout/create-session', () => {
  let productId: string;
  let variantId: string;
  let agencyId: string;
  let influencerId: string;

  const baseCustomer = {
    customerName: 'テスト太郎',
    customerEmail: '',
    customerPhone: '090-1234-5678',
    customerPostalCode: '100-0001',
    customerAddress: '東京都千代田区1-1-1',
    agreedToTerms: true,
  };

  beforeAll(async () => {
    const product = await prisma.product.create({
      data: {
        name: 'テスト商品',
        slug: `test-checkout-product-${Date.now()}`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 10000,
        status: 'published',
      },
    });
    productId = product.id;

    const variant = await prisma.productVariant.create({
      data: { productId, name: 'テストA', price: 10000, stock: 2, reservedStock: 0 },
    });
    variantId = variant.id;

    const agency = await prisma.agency.create({
      data: { name: 'テスト代理店', code: `TESTAG-${Date.now()}`, defaultCommissionRate: 15 },
    });
    agencyId = agency.id;

    const influencer = await prisma.influencer.create({
      data: { agencyId, name: 'テストインフルエンサー', code: `TESTINF-${Date.now()}` },
    });
    influencerId = influencer.id;

    await prisma.referralLink.create({
      data: { code: `TESTREF-${Date.now()}`.slice(0, 20), agencyId, influencerId, landingPath: '/products/test' },
    });
  });

  afterAll(async () => {
    await prisma.orderItem.deleteMany({ where: { productId } });
    await prisma.order.deleteMany({ where: { customerEmail: { contains: 'checkout-test' } } });
    await prisma.referralLink.deleteMany({ where: { agencyId } });
    await prisma.influencer.deleteMany({ where: { id: influencerId } });
    await prisma.agency.deleteMany({ where: { id: agencyId } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.user.deleteMany({ where: { email: { contains: 'checkout-test' } } });
    await prisma.$disconnect();
  });

  it('正常に注文を仮作成し在庫を仮引当する', async () => {
    const email = `normal-checkout-test-${Date.now()}@example.com`;
    const res = await request(app)
      .post('/api/checkout/create-session')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', referralCookieHeader())
      .send({ ...baseCustomer, customerEmail: email, items: [{ variantId, quantity: 1 }] });

    expect(res.status).toBe(201);
    expect(res.body.orderNumber).toMatch(/^SG-\d{8}-\d{4}$/);
    expect(res.body.totalAmount).toBe(10000);

    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
    expect(variant.reservedStock).toBe(1);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } });
    expect(order.paymentStatus).toBe('pending');
    expect(order.termsVersion).toBe(process.env.TERMS_VERSION);

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();
  });

  it('同一メールアドレスで再注文しても新規ユーザーは作成されない', async () => {
    const email = `repeat-checkout-test-${Date.now()}@example.com`;
    await request(app)
      .post('/api/checkout/create-session')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', referralCookieHeader())
      .send({ ...baseCustomer, customerEmail: email, items: [{ variantId, quantity: 1 }] });

    const userCountAfterFirst = await prisma.user.count({ where: { email } });
    expect(userCountAfterFirst).toBe(1);

    await prisma.productVariant.update({ where: { id: variantId }, data: { reservedStock: 0 } });

    await request(app)
      .post('/api/checkout/create-session')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', referralCookieHeader())
      .send({ ...baseCustomer, customerEmail: email, items: [{ variantId, quantity: 1 }] });

    const userCountAfterSecond = await prisma.user.count({ where: { email } });
    expect(userCountAfterSecond).toBe(1);
  });

  it('在庫を超える数量はSTOCK_INSUFFICIENTで409を返し、在庫は変化しない', async () => {
    const email = `stockfail-checkout-test-${Date.now()}@example.com`;
    await prisma.productVariant.update({ where: { id: variantId }, data: { reservedStock: 0 } });

    const res = await request(app)
      .post('/api/checkout/create-session')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', referralCookieHeader())
      .send({ ...baseCustomer, customerEmail: email, items: [{ variantId, quantity: 999 }] });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STOCK_INSUFFICIENT');

    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
    expect(variant.reservedStock).toBe(0);
  });

  it('規約未同意はTERMS_NOT_AGREEDで400を返す', async () => {
    const res = await request(app)
      .post('/api/checkout/create-session')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', referralCookieHeader())
      .send({
        ...baseCustomer,
        customerEmail: `terms-checkout-test-${Date.now()}@example.com`,
        agreedToTerms: false,
        items: [{ variantId, quantity: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TERMS_NOT_AGREED');
  });

  it('紹介コードなしの場合はcommission_rate=0でreferrer_nameはnull', async () => {
    const email = `noref-checkout-test-${Date.now()}@example.com`;
    const res = await request(app)
      .post('/api/checkout/create-session')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', referralCookieHeader())
      .send({ ...baseCustomer, customerEmail: email, items: [{ variantId, quantity: 1 }] });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } });
    expect(Number(order.commissionRate)).toBe(0);
    expect(order.referrerName).toBeNull();
  });

  it('存在する紹介コードでcommission_rateが3段階フォールバックで解決される(代理店のdefault)', async () => {
    const referralLink = await prisma.referralLink.findFirstOrThrow({ where: { agencyId } });
    const email = `withref-checkout-test-${Date.now()}@example.com`;

    const res = await request(app)
      .post('/api/checkout/create-session')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', referralCookieHeader())
      .send({
        ...baseCustomer,
        customerEmail: email,
        referralCode: referralLink.code,
        items: [{ variantId, quantity: 1 }],
      });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } });
    expect(Number(order.commissionRate)).toBe(15);
    expect(order.referrerName).toBe('テストインフルエンサー');
    expect(order.agencyId).toBe(agencyId);
    expect(order.influencerId).toBe(influencerId);
  });

  describe('代理店への永久帰属(仕様書外の拡張)', () => {
    beforeAll(async () => {
      await prisma.productVariant.update({ where: { id: variantId }, data: { reservedStock: 0 } });
    });

    it('初回購入で紹介コードを使うと、ユーザーに代理店が永久帰属される', async () => {
      const referralLink = await prisma.referralLink.findFirstOrThrow({ where: { agencyId } });
      const email = `perm-first-checkout-test-${Date.now()}@example.com`;

      await request(app)
        .post('/api/checkout/create-session')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', referralCookieHeader())
        .send({
          ...baseCustomer,
          customerEmail: email,
          referralCode: referralLink.code,
          items: [{ variantId, quantity: 1 }],
        });

      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.referredByAgencyId).toBe(agencyId);
      expect(user.referredByInfluencerId).toBe(influencerId);
      expect(user.referredByReferralLinkId).toBe(referralLink.id);
      expect(user.referredByCode).toBe(referralLink.code);
      expect(user.referredAt).not.toBeNull();
    });

    it('永久帰属済みユーザーが紹介コードなしで再購入しても、元の代理店に報酬が発生する', async () => {
      const referralLink = await prisma.referralLink.findFirstOrThrow({ where: { agencyId } });
      const email = `perm-repeat-noref-checkout-test-${Date.now()}@example.com`;

      await request(app)
        .post('/api/checkout/create-session')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', referralCookieHeader())
        .send({
          ...baseCustomer,
          customerEmail: email,
          referralCode: referralLink.code,
          items: [{ variantId, quantity: 1 }],
        });

      await prisma.productVariant.update({ where: { id: variantId }, data: { reservedStock: 0 } });

      const res = await request(app)
        .post('/api/checkout/create-session')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', referralCookieHeader())
        .send({ ...baseCustomer, customerEmail: email, items: [{ variantId, quantity: 1 }] });

      const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } });
      expect(order.agencyId).toBe(agencyId);
      expect(order.influencerId).toBe(influencerId);
      expect(Number(order.commissionRate)).toBe(15);
    });

    it('永久帰属済みユーザーが別の代理店の紹介コードで再購入しても、元の代理店に報酬が発生する', async () => {
      const originalLink = await prisma.referralLink.findFirstOrThrow({ where: { agencyId } });
      const email = `perm-repeat-otherref-checkout-test-${Date.now()}@example.com`;

      await request(app)
        .post('/api/checkout/create-session')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', referralCookieHeader())
        .send({
          ...baseCustomer,
          customerEmail: email,
          referralCode: originalLink.code,
          items: [{ variantId, quantity: 1 }],
        });

      const otherAgency = await prisma.agency.create({
        data: { name: '別の代理店', code: `OTHERAG-${Date.now()}`, defaultCommissionRate: 30 },
      });
      const otherLink = await prisma.referralLink.create({
        data: { code: `OTHERREF-${Date.now()}`.slice(0, 20), agencyId: otherAgency.id, landingPath: '/products/other' },
      });

      await prisma.productVariant.update({ where: { id: variantId }, data: { reservedStock: 0 } });

      const res = await request(app)
        .post('/api/checkout/create-session')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', referralCookieHeader())
        .send({ ...baseCustomer, customerEmail: email, referralCode: otherLink.code, items: [{ variantId, quantity: 1 }] });

      const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } });
      expect(order.agencyId).toBe(agencyId);
      expect(order.agencyId).not.toBe(otherAgency.id);
      expect(Number(order.commissionRate)).toBe(15);

      await prisma.referralLink.delete({ where: { id: otherLink.id } });
      await prisma.agency.delete({ where: { id: otherAgency.id } });
    });

    it('帰属後に代理店のdefault_commission_rateが変わると、次回注文には新しい率が反映される(率は都度再解決、帰属先は固定)', async () => {
      const referralLink = await prisma.referralLink.findFirstOrThrow({ where: { agencyId } });
      const email = `perm-repeat-newrate-checkout-test-${Date.now()}@example.com`;

      await request(app)
        .post('/api/checkout/create-session')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', referralCookieHeader())
        .send({
          ...baseCustomer,
          customerEmail: email,
          referralCode: referralLink.code,
          items: [{ variantId, quantity: 1 }],
        });

      await prisma.agency.update({ where: { id: agencyId }, data: { defaultCommissionRate: 20 } });
      await prisma.productVariant.update({ where: { id: variantId }, data: { reservedStock: 0 } });

      const res = await request(app)
        .post('/api/checkout/create-session')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', referralCookieHeader())
        .send({ ...baseCustomer, customerEmail: email, items: [{ variantId, quantity: 1 }] });

      const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } });
      expect(order.agencyId).toBe(agencyId);
      expect(Number(order.commissionRate)).toBe(20);

      await prisma.agency.update({ where: { id: agencyId }, data: { defaultCommissionRate: 15 } });
    });
  });
});
