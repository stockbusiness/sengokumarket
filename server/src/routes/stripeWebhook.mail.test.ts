import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { createPendingOrder } from '../services/checkout';
import { setSetting } from '../services/settings';
import { dispatchPendingNotifications } from '../modules/notifications/application/dispatchNotificationOutbox.usecase';

const sendNotificationOrThrowMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../modules/notifications/application/sendNotification.usecase', () => ({
  sendNotification: async (..._args: unknown[]) => {},
  sendNotificationOrThrow: (...args: unknown[]) => sendNotificationOrThrowMock(...args),
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

// Wallet Claim本番前安定化指示書(2026-07-25)Phase11(13.2「Stripe WebhookがResendを待たない」):
// Webhookハンドラは通知予定(Outbox)を作成するのみで、実送信(Resend呼び出し)は行わない。
// このテストではOutboxへ正しい内容が記録されることと、Dispatcher実行(5分Cron相当)を手動で
// 呼び出した際に正しいメールが組み立てられることの両方を確認する。
describe('checkout.session.completed のメール送信連携(通知Outbox化・本番前安定化指示書Phase11)', () => {
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

  afterEach(() => {
    sendNotificationOrThrowMock.mockClear();
  });

  afterAll(async () => {
    await prisma.notificationOutboxEvent.deleteMany({ where: { recipient: { contains: 'mail-webhook-test' } } });
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

  it('新規ゲストユーザーの場合、購入完了・ゲストパスワード設定の両方の通知予定がpendingで作成される(Resend未呼び出し)', async () => {
    const email = `mail-webhook-test-guest-${Date.now()}@example.com`;
    const { order, sessionId } = await createOrder(email);
    expect(order.guestAccountCreated).toBe(true);

    await postWebhook({
      id: `evt_test_mail_guest_${Date.now()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sessionId, payment_intent: `pi_test_${Date.now()}`, metadata: { order_id: order.id } } },
    });

    // Webhook応答の時点ではResend呼び出し(実送信)は一切行われていない。
    expect(sendNotificationOrThrowMock).not.toHaveBeenCalled();

    const events = await prisma.notificationOutboxEvent.findMany({ where: { recipient: email } });
    expect(events.map((e) => e.eventType).sort()).toEqual(['guest_password_setup', 'purchase_complete']);
    expect(events.every((e) => e.status === 'pending')).toBe(true);

    // 5分Cron相当のDispatcherを手動実行し、実際にメール組み立て・送信(mock)まで完了することを確認する。
    await dispatchPendingNotifications();
    expect(sendNotificationOrThrowMock).toHaveBeenCalledTimes(2);

    const tokenCount = await prisma.passwordResetToken.count({ where: { userId: order.userId! } });
    expect(tokenCount).toBe(1);

    const updatedEvents = await prisma.notificationOutboxEvent.findMany({ where: { recipient: email } });
    expect(updatedEvents.every((e) => e.status === 'succeeded')).toBe(true);
  });

  it('既存ユーザーの場合、購入完了の通知予定のみ作成されゲストパスワード設定は作られない', async () => {
    const email = `mail-webhook-test-existing-${Date.now()}@example.com`;

    // 1回目の注文で既存ユーザー化しておく
    await createOrder(email);
    const { order, sessionId } = await createOrder(email);
    expect(order.guestAccountCreated).toBe(false);

    await postWebhook({
      id: `evt_test_mail_existing_${Date.now()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sessionId, payment_intent: `pi_test_${Date.now()}`, metadata: { order_id: order.id } } },
    });

    const events = await prisma.notificationOutboxEvent.findMany({ where: { recipient: email, eventType: 'purchase_complete' } });
    expect(events).toHaveLength(1);
    const guestEvents = await prisma.notificationOutboxEvent.findMany({ where: { recipient: email, eventType: 'guest_password_setup' } });
    expect(guestEvents).toHaveLength(0);
  });
});

describe('checkout.session.expired のカート放棄リマインドメール送信(仕様書外の拡張・Phase11)', () => {
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

  afterEach(() => {
    sendNotificationOrThrowMock.mockClear();
  });

  afterAll(async () => {
    await prisma.notificationOutboxEvent.deleteMany({ where: { recipient: { contains: 'mail-webhook-expired-test' } } });
    await prisma.orderItem.deleteMany({ where: { productId } });
    await prisma.order.deleteMany({ where: { customerEmail: { contains: 'mail-webhook-expired-test' } } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.setting.deleteMany({ where: { key: 'stripe_webhook_secret' } });
    await prisma.$disconnect();
  });

  it('決済セッションが期限切れになるとカート放棄リマインドの通知予定がpendingで作成され、Dispatcher実行で正しい商品を含めて送信される', async () => {
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

    await postWebhook({
      id: `evt_test_expired_mail_${Date.now()}`,
      type: 'checkout.session.expired',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sessionId, metadata: { order_id: order.id } } },
    });

    expect(sendNotificationOrThrowMock).not.toHaveBeenCalled();
    const event = await prisma.notificationOutboxEvent.findFirstOrThrow({ where: { recipient: email, eventType: 'cart_abandoned' } });
    expect(event.status).toBe('pending');
    expect((event.payload as Record<string, unknown>).orderId).toBe(order.id);

    await dispatchPendingNotifications();
    expect(sendNotificationOrThrowMock).toHaveBeenCalledTimes(1);
    const sentMessage = sendNotificationOrThrowMock.mock.calls[0][0] as { text: string };
    expect(sentMessage.text).toContain(`/products/${productSlug}`);
  });
});
