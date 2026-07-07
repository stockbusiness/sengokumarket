import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { generateAgencyCode } from '../../services/referralCodeGenerator';
import { referralCookieHeader } from '../../test/referralCookie';
import { TEST_ORIGIN } from '../../test/adminAgent';

// 注文作成の業務ロジックのみを検証するため、実際のStripe API呼び出しはダミー実装に差し替える。
vi.mock('../../services/stripeCheckout', () => ({
  createStripeCheckoutSession: vi.fn(async () => ({
    id: `cs_test_${Math.random().toString(36).slice(2)}`,
    url: 'https://checkout.stripe.com/test-session',
  })),
}));

const app = createApp();

async function createAgencyAgent(name: string) {
  const agency = await prisma.$transaction(async (tx) => {
    const code = await generateAgencyCode(tx);
    return tx.agency.create({ data: { name, code, defaultCommissionRate: 10 } });
  });

  const email = `agency-orders-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await prisma.user.create({
    data: { name, email, passwordHash: await bcrypt.hash('agencypassword1', 10), role: 'agency', agencyId: agency.id },
  });

  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'agencypassword1' });

  return { agent, agency };
}

describe('代理店ポータル: 紹介経由の購入者一覧', () => {
  let productId: string;
  let variantId: string;

  afterAll(async () => {
    await prisma.orderItem.deleteMany({ where: { productId } });
    await prisma.order.deleteMany({ where: { customerEmail: { contains: 'agency-orders-test' } } });
    await prisma.referralLink.deleteMany({ where: { agency: { name: { contains: 'agency-orders-test' } } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'agency-orders-test' } } });
    await prisma.agency.deleteMany({ where: { name: { contains: 'agency-orders-test' } } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.delete({ where: { id: productId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('一般ユーザーは403', async () => {
    const email = `agency-orders-test-general-${Date.now()}@example.com`;
    const agent = request.agent(app);
    await agent.post('/api/auth/register').set('Origin', TEST_ORIGIN).send({ name: '一般', email, password: 'password123' });

    const res = await agent.get('/api/agency/orders');
    expect(res.status).toBe(403);
  });

  it('自代理店経由の購入者名・購入アイテム・購入価格のみを取得できる(報酬情報は含まれない)', async () => {
    const product = await prisma.product.create({
      data: {
        name: 'テスト会員証',
        slug: `agency-orders-test-product-${Date.now()}`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 25000,
        status: 'published',
      },
    });
    productId = product.id;
    const variant = await prisma.productVariant.create({
      data: { productId, name: 'Black', price: 25000, stock: 10, reservedStock: 0 },
    });
    variantId = variant.id;

    const { agent: agentA, agency: agencyA } = await createAgencyAgent('agency-orders-test-A');
    const { agent: agentB } = await createAgencyAgent('agency-orders-test-B');

    const referralLink = await prisma.referralLink.create({
      data: { code: `AOTREF-${Date.now()}`.slice(0, 20), agencyId: agencyA.id, landingPath: '/products' },
    });

    const buyerEmail = `agency-orders-test-buyer-${Date.now()}@example.com`;
    const checkoutRes = await request(app)
      .post('/api/checkout/create-session')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', referralCookieHeader())
      .send({
        customerName: '購入太郎',
        customerEmail: buyerEmail,
        customerPhone: '090-1234-5678',
        customerPostalCode: '100-0001',
        customerAddress: '東京都千代田区1-1-1',
        agreedToTerms: true,
        referralCode: referralLink.code,
        items: [{ variantId, quantity: 1 }],
      });
    expect(checkoutRes.status).toBe(201);

    const resA = await agentA.get('/api/agency/orders');
    expect(resA.status).toBe(200);
    expect(resA.body.orders).toHaveLength(1);
    const order = resA.body.orders[0];
    expect(order.customerName).toBe('購入太郎');
    expect(order.totalAmount).toBe(25000);
    expect(order.items).toEqual([{ productName: 'テスト会員証', variantName: 'Black', quantity: 1 }]);
    expect(order).not.toHaveProperty('commissionAmount');
    expect(order).not.toHaveProperty('commissionRate');
    expect(order).not.toHaveProperty('commissionStatus');

    const resB = await agentB.get('/api/agency/orders');
    expect(resB.status).toBe(200);
    expect(resB.body.orders).toHaveLength(0);
  });
});
