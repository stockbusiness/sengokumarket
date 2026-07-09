import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { createPendingOrder } from '../services/checkout';
import { setSetting } from '../services/settings';

const app = createApp();
const WEBHOOK_SECRET = 'whsec_test_coupon_dummy_secret';
const MARK = 'webhook-coupon-test';

function sign(payloadObj: unknown) {
  const payload = JSON.stringify(payloadObj);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, header };
}

async function postWebhook(payloadObj: unknown) {
  const { payload, header } = sign(payloadObj);
  return request(app).post('/api/stripe/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', header).send(payload);
}

describe('クーポン機能とStripe Webhookの統合(仕様書外の拡張)', () => {
  let variantId: string;
  let agencyId: string;

  beforeAll(async () => {
    await setSetting('stripe_webhook_secret', WEBHOOK_SECRET);

    const product = await prisma.product.create({
      data: { name: 'クーポンWebhookテスト商品', slug: `${MARK}-${Date.now()}`, category: 'テスト', itemType: 'nft', basePrice: 50000, status: 'published' },
    });
    const variant = await prisma.productVariant.create({
      data: { productId: product.id, name: 'A', price: 50000, stock: 10, reservedStock: 0 },
    });
    variantId = variant.id;

    const agency = await prisma.agency.create({ data: { name: 'テスト代理店', code: `${MARK}-AG-${Date.now()}`, defaultCommissionRate: 40 } });
    agencyId = agency.id;
  });

  afterAll(async () => {
    await prisma.couponUsage.deleteMany({ where: { coupon: { code: { contains: MARK } } } });
    await prisma.commission.deleteMany({ where: { agencyId } });
    await prisma.nftIssue.deleteMany({ where: { order: { customerEmail: { contains: MARK } } } });
    await prisma.orderItem.deleteMany({ where: { order: { customerEmail: { contains: MARK } } } });
    await prisma.order.deleteMany({ where: { customerEmail: { contains: MARK } } });
    await prisma.referralLink.deleteMany({ where: { agencyId } });
    await prisma.coupon.deleteMany({ where: { code: { contains: MARK } } });
    await prisma.agency.deleteMany({ where: { id: agencyId } });
    await prisma.productVariant.deleteMany({ where: { id: variantId } });
    await prisma.product.deleteMany({ where: { slug: { contains: MARK } } });
    await prisma.passwordResetToken.deleteMany({ where: { user: { email: { contains: MARK } } } });
    await prisma.user.deleteMany({ where: { email: { contains: MARK } } });
    await prisma.setting.deleteMany({ where: { key: 'stripe_webhook_secret' } });
    await prisma.$disconnect();
  });

  it('決済完了時、割引後金額を基準に代理店報酬が計算され、クーポンがusedになる(既存の報酬計算関数をそのまま利用)', async () => {
    const coupon = await prisma.coupon.create({
      data: { code: `${MARK}-FIXED-${Date.now()}`, name: 'テストクーポン', discountType: 'fixed', discountAmount: 5000 },
    });
    const referralLink = await prisma.referralLink.create({
      data: { code: `${MARK}REF${Date.now()}`, agencyId, landingPath: '/products/test', couponId: coupon.id, couponAutoApply: true },
    });

    const email = `${MARK}-confirm-${Date.now()}@example.com`;
    const { order } = await createPendingOrder({
      customerName: 'テスト',
      customerEmail: email,
      customerPhone: '090-0000-0000',
      customerPostalCode: '100-0001',
      customerAddress: '東京都千代田区1-1-1',
      referralCode: referralLink.code,
      agreedToTerms: true,
      items: [{ variantId, quantity: 1 }],
    });

    // 商品価格50,000円 - クーポン5,000円 = 45,000円が実際の決済対象額になっていること
    expect(order.originalAmount).toBe(50000);
    expect(order.couponDiscountAmount).toBe(5000);
    expect(order.totalAmount).toBe(45000);

    const sessionId = `cs_test_${Math.random().toString(36).slice(2)}`;
    await prisma.order.update({ where: { id: order.id }, data: { stripeSessionId: sessionId } });

    await postWebhook({
      id: `evt_${MARK}_${Date.now()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sessionId, payment_intent: `pi_${Date.now()}`, metadata: { order_id: order.id } } },
    });

    // 代理店報酬は割引後の45,000円 × 40% = 18,000円(createCommissionForOrderの改変なしで反映される)
    const commission = await prisma.commission.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(commission.baseAmount).toBe(45000);
    expect(commission.commissionAmount).toBe(18000);

    const usage = await prisma.couponUsage.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(usage.status).toBe('used');

    const updatedCoupon = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
    expect(updatedCoupon.usedCount).toBe(1);
    expect(updatedCoupon.reservedCount).toBe(0);
  });

  it('checkout.session.expiredでクーポンの予約が解放される', async () => {
    const coupon = await prisma.coupon.create({
      data: { code: `${MARK}-EXPIRE-${Date.now()}`, name: 'テストクーポン', discountType: 'fixed', discountAmount: 5000 },
    });
    const referralLink = await prisma.referralLink.create({
      data: { code: `${MARK}EXP${Date.now()}`, agencyId, landingPath: '/products/test', couponId: coupon.id, couponAutoApply: true },
    });

    const email = `${MARK}-expire-${Date.now()}@example.com`;
    const { order } = await createPendingOrder({
      customerName: 'テスト',
      customerEmail: email,
      customerPhone: '090-0000-0000',
      customerPostalCode: '100-0001',
      customerAddress: '東京都千代田区1-1-1',
      referralCode: referralLink.code,
      agreedToTerms: true,
      items: [{ variantId, quantity: 1 }],
    });

    const sessionId = `cs_test_${Math.random().toString(36).slice(2)}`;
    await prisma.order.update({ where: { id: order.id }, data: { stripeSessionId: sessionId } });

    const afterReserve = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
    expect(afterReserve.reservedCount).toBe(1);

    await postWebhook({
      id: `evt_${MARK}_expire_${Date.now()}`,
      type: 'checkout.session.expired',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sessionId, metadata: { order_id: order.id } } },
    });

    const usage = await prisma.couponUsage.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(usage.status).toBe('expired');

    const afterExpire = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
    expect(afterExpire.reservedCount).toBe(0);
  });

  it('全額返金でrestoreOnCancel=trueならクーポンが再利用可能に戻る', async () => {
    const coupon = await prisma.coupon.create({
      data: {
        code: `${MARK}-REFUND-${Date.now()}`,
        name: 'テストクーポン',
        discountType: 'fixed',
        discountAmount: 5000,
        restoreOnCancel: true,
      },
    });
    const referralLink = await prisma.referralLink.create({
      data: {
        code: `${MARK}RFD${Date.now()}`,
        agencyId,
        landingPath: '/products/test',
        couponId: coupon.id,
        couponAutoApply: true,
      },
    });

    const email = `${MARK}-refund-${Date.now()}@example.com`;
    const { order } = await createPendingOrder({
      customerName: 'テスト',
      customerEmail: email,
      customerPhone: '090-0000-0000',
      customerPostalCode: '100-0001',
      customerAddress: '東京都千代田区1-1-1',
      referralCode: referralLink.code,
      agreedToTerms: true,
      items: [{ variantId, quantity: 1 }],
    });

    const sessionId = `cs_test_${Math.random().toString(36).slice(2)}`;
    const paymentIntentId = `pi_${MARK}_${Date.now()}`;
    await prisma.order.update({ where: { id: order.id }, data: { stripeSessionId: sessionId } });

    await postWebhook({
      id: `evt_${MARK}_paid_${Date.now()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sessionId, payment_intent: paymentIntentId, metadata: { order_id: order.id } } },
    });

    await postWebhook({
      id: `evt_${MARK}_refund_${Date.now()}`,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: { object: { payment_intent: paymentIntentId, amount: 45000, amount_refunded: 45000 } },
    });

    const usage = await prisma.couponUsage.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(usage.status).toBe('cancelled');

    const updatedCoupon = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
    expect(updatedCoupon.usedCount).toBe(0);
  });
});
