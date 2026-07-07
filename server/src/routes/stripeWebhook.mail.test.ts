import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { createPendingOrder } from '../services/checkout';
import { setSetting } from '../services/settings';

const sendPurchaseCompleteEmail = vi.fn(async (..._args: unknown[]) => {});
const sendGuestPasswordSetupEmail = vi.fn(async (..._args: unknown[]) => {});
const sendCartAbandonedEmail = vi.fn(async (..._args: unknown[]) => {});

vi.mock('../services/mailTemplates', () => ({
  sendPurchaseCompleteEmail: (...args: unknown[]) => sendPurchaseCompleteEmail(...args),
  sendGuestPasswordSetupEmail: (...args: unknown[]) => sendGuestPasswordSetupEmail(...args),
  sendCartAbandonedEmail: (...args: unknown[]) => sendCartAbandonedEmail(...args),
  sendPasswordResetEmail: vi.fn(async () => {}),
}));

const app = createApp();
const WEBHOOK_SECRET = 'whsec_test_mail_dummy_secret';

function sign(payloadObj: unknown) {
  const payload = JSON.stringify(payloadObj);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, header };
}

async function postWebhook(payloadObj: unknown) {
  const { payload, header } = sign(payloadObj);
  return request(app)
    .post('/api/stripe/webhook')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', header)
    .send(payload);
}

describe('checkout.session.completed のメール送信連携', () => {
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    await setSetting('stripe_webhook_secret', WEBHOOK_SECRET);

    const product = await prisma.product.create({
      data: {
        name: 'メールテスト商品',
        slug: `mail-webhook-test-${Date.now()}`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 10000,
        status: 'published',
      },
    });
    productId = product.id;
    const variant = await prisma.productVariant.create({
      data: { productId, name: 'A', price: 10000, stock: 10 },
    });
    variantId = variant.id;
  });

  afterAll(async () => {
    await prisma.nftIssue.deleteMany({ where: { productId } });
    await prisma.orderItem.deleteMany({ where: { productId } });
    await prisma.order.deleteMany({ where: { customerEmail: { contains: 'mail-webhook-test' } } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.passwordResetToken.deleteMany({ where: { user: { email: { contains: 'mail-webhook-test' } } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'mail-webhook-test' } } });
    await prisma.setting.deleteMany({ where: { key: 'stripe_webhook_secret' } });
    await prisma.$disconnect();
  });

  async function createOrder(email: string) {
    const { order } = await createPendingOrder({
      customerName: 'テスト',
      customerEmail: email,
      customerPhone: '090-0000-0000',
      customerPostalCode: '100-0001',
      customerAddress: '東京都千代田区1-1-1',
      agreedToTerms: true,
      items: [{ variantId, quantity: 1 }],
    });
    const sessionId = `cs_test_mail_${Math.random().toString(36).slice(2)}`;
    await prisma.order.update({ where: { id: order.id }, data: { stripeSessionId: sessionId } });
    return { order, sessionId };
  }

  it('新規ゲストユーザーの場合、購入完了メールとパスワード設定メールの両方が送信される', async () => {
    const email = `mail-webhook-test-guest-${Date.now()}@example.com`;
    const { order, sessionId } = await createOrder(email);
    expect(order.guestAccountCreated).toBe(true);

    sendPurchaseCompleteEmail.mockClear();
    sendGuestPasswordSetupEmail.mockClear();

    await postWebhook({
      id: `evt_test_mail_guest_${Date.now()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sessionId, payment_intent: `pi_test_${Date.now()}`, metadata: { order_id: order.id } } },
    });

    expect(sendPurchaseCompleteEmail).toHaveBeenCalledTimes(1);
    expect(sendGuestPasswordSetupEmail).toHaveBeenCalledTimes(1);

    const tokenCount = await prisma.passwordResetToken.count({ where: { userId: order.userId! } });
    expect(tokenCount).toBe(1);
  });

  it('既存ユーザーの場合、購入完了メールのみ送信されパスワード設定メールは送られない', async () => {
    const email = `mail-webhook-test-existing-${Date.now()}@example.com`;

    // 1回目の注文で既存ユーザー化しておく
    await createOrder(email);
    const { order, sessionId } = await createOrder(email);
    expect(order.guestAccountCreated).toBe(false);

    sendPurchaseCompleteEmail.mockClear();
    sendGuestPasswordSetupEmail.mockClear();

    await postWebhook({
      id: `evt_test_mail_existing_${Date.now()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sessionId, payment_intent: `pi_test_${Date.now()}`, metadata: { order_id: order.id } } },
    });

    expect(sendPurchaseCompleteEmail).toHaveBeenCalledTimes(1);
    expect(sendGuestPasswordSetupEmail).not.toHaveBeenCalled();
  });
});

describe('checkout.session.expired のカート放棄リマインドメール送信(仕様書外の拡張)', () => {
  let productId: string;
  let productSlug: string;
  let variantId: string;

  beforeAll(async () => {
    await setSetting('stripe_webhook_secret', WEBHOOK_SECRET);

    productSlug = `mail-webhook-expired-test-${Date.now()}`;
    const product = await prisma.product.create({
      data: {
        name: 'カート放棄テスト商品',
        slug: productSlug,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 10000,
        status: 'published',
      },
    });
    productId = product.id;
    const variant = await prisma.productVariant.create({
      data: { productId, name: 'A', price: 10000, stock: 10 },
    });
    variantId = variant.id;
  });

  afterAll(async () => {
    await prisma.orderItem.deleteMany({ where: { productId } });
    await prisma.order.deleteMany({ where: { customerEmail: { contains: 'mail-webhook-expired-test' } } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.setting.deleteMany({ where: { key: 'stripe_webhook_secret' } });
    await prisma.$disconnect();
  });

  it('決済セッションが期限切れになるとカート放棄リマインドメールが送信される', async () => {
    const email = `mail-webhook-expired-test-${Date.now()}@example.com`;
    const { order } = await createPendingOrder({
      customerName: 'テスト',
      customerEmail: email,
      customerPhone: '090-0000-0000',
      customerPostalCode: '100-0001',
      customerAddress: '東京都千代田区1-1-1',
      agreedToTerms: true,
      items: [{ variantId, quantity: 1 }],
    });
    const sessionId = `cs_test_expired_mail_${Math.random().toString(36).slice(2)}`;
    await prisma.order.update({ where: { id: order.id }, data: { stripeSessionId: sessionId } });

    sendCartAbandonedEmail.mockClear();

    await postWebhook({
      id: `evt_test_expired_mail_${Date.now()}`,
      type: 'checkout.session.expired',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sessionId, metadata: { order_id: order.id } } },
    });

    expect(sendCartAbandonedEmail).toHaveBeenCalledTimes(1);
    expect(sendCartAbandonedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ id: order.id }),
      expect.any(Array),
      productSlug,
    );
  });
});
