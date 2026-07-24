import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { createPendingOrder } from '../services/checkout';
import { setSetting } from '../services/settings';
import { hashPayload } from '../services/stripeEventInbox';

// 本番安定化指示書Stage1: Stripe Webhookの応答経路から外部API待ちの同期ディスパッチを
// 除去したことの回帰確認用。将来これらの呼び出しがうっかり復活していないかをspyで検知する。
const triggerImmediateNftMintProcessing = vi.fn(async () => {});
const triggerImmediateOrderLinkingDispatch = vi.fn(async () => {});
const triggerImmediateOutboxDispatch = vi.fn(async () => {});

vi.mock('../services/nftMintProcessing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/nftMintProcessing')>();
  return { ...actual, triggerImmediateNftMintProcessing: () => triggerImmediateNftMintProcessing() };
});
vi.mock('../services/orderLinkingJobDispatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/orderLinkingJobDispatcher')>();
  return { ...actual, triggerImmediateOrderLinkingDispatch: () => triggerImmediateOrderLinkingDispatch() };
});
vi.mock('../services/integrationOutboxDispatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/integrationOutboxDispatcher')>();
  return { ...actual, triggerImmediateOutboxDispatch: () => triggerImmediateOutboxDispatch() };
});

const app = createApp();
const WEBHOOK_SECRET = 'whsec_test_dummy_secret_for_local_tests';

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

describe('POST /api/stripe/webhook', () => {
  let nftProductId: string;
  let nftVariantId: string;
  let physicalProductId: string;
  let physicalVariantId: string;
  let agencyId: string;

  beforeAll(async () => {
    await setSetting('stripe_webhook_secret', WEBHOOK_SECRET);

    const nftProduct = await prisma.product.create({
      data: {
        name: 'Webhookテスト評議員証',
        slug: `webhook-test-nft-${Date.now()}`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 20000,
        status: 'published',
      },
    });
    nftProductId = nftProduct.id;
    const nftVariant = await prisma.productVariant.create({
      data: { productId: nftProductId, name: 'Black', price: 20000, stock: 10, reservedStock: 0 },
    });
    nftVariantId = nftVariant.id;

    const physicalProduct = await prisma.product.create({
      data: {
        name: 'Webhookテスト物販',
        slug: `webhook-test-physical-${Date.now()}`,
        category: 'テスト',
        itemType: 'physical',
        basePrice: 1000,
        status: 'published',
      },
    });
    physicalProductId = physicalProduct.id;
    const physicalVariant = await prisma.productVariant.create({
      data: { productId: physicalProductId, name: '通常', price: 1000, stock: 10, reservedStock: 0 },
    });
    physicalVariantId = physicalVariant.id;

    const agency = await prisma.agency.create({
      data: { name: 'Webhookテスト代理店', code: `WHAG-${Date.now()}`, defaultCommissionRate: 10 },
    });
    agencyId = agency.id;
  });

  afterAll(async () => {
    await prisma.nftIssue.deleteMany({ where: { productId: { in: [nftProductId, physicalProductId] } } });
    await prisma.commission.deleteMany({ where: { agencyId } });
    await prisma.orderItem.deleteMany({ where: { productId: { in: [nftProductId, physicalProductId] } } });
    await prisma.order.deleteMany({ where: { customerEmail: { contains: 'webhook-test' } } });
    await prisma.referralLink.deleteMany({ where: { agencyId } });
    await prisma.agency.delete({ where: { id: agencyId } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: [nftProductId, physicalProductId] } } });
    await prisma.product.deleteMany({ where: { id: { in: [nftProductId, physicalProductId] } } });
    await prisma.passwordResetToken.deleteMany({ where: { user: { email: { contains: 'webhook-test' } } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'webhook-test' } } });
    await prisma.setting.deleteMany({ where: { key: 'stripe_webhook_secret' } });
    await prisma.$disconnect();
  });

  async function createTestOrder(email: string, referralCode?: string) {
    const { order } = await createPendingOrder({
      customerName: 'Webhookテスト太郎',
      customerEmail: email,
      customerPhone: '090-0000-0000',
      customerPostalCode: '100-0001',
      customerAddress: '東京都千代田区1-1-1',
      referralCode: referralCode ?? null,
      agreedToTerms: true,
      items: [
        { variantId: nftVariantId, quantity: 2 },
        { variantId: physicalVariantId, quantity: 1 },
      ],
    });
    const sessionId = `cs_test_${Math.random().toString(36).slice(2)}`;
    await prisma.order.update({ where: { id: order.id }, data: { stripeSessionId: sessionId } });
    return { order, sessionId };
  }

  it('checkout.session.completedで在庫確定・NFT発行データ作成(nftのみ)・二重処理防止まで行う', async () => {
    const email = `webhook-test-completed-${Date.now()}@example.com`;
    const { order, sessionId } = await createTestOrder(email);
    const paymentIntentId = `pi_test_${Math.random().toString(36).slice(2)}`;
    const eventId = `evt_test_completed_${Date.now()}`;

    const eventPayload = {
      id: eventId,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: sessionId,
          payment_intent: paymentIntentId,
          metadata: { order_id: order.id },
        },
      },
    };

    const res1 = await postWebhook(eventPayload);
    expect(res1.status).toBe(200);

    const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updatedOrder.paymentStatus).toBe('paid');
    expect(updatedOrder.orderStatus).toBe('paid');
    expect(updatedOrder.paidAt).not.toBeNull();
    expect(updatedOrder.stripePaymentIntentId).toBe(paymentIntentId);

    const nftVariant = await prisma.productVariant.findUniqueOrThrow({ where: { id: nftVariantId } });
    expect(nftVariant.stock).toBe(8); // 10 - 2
    expect(nftVariant.reservedStock).toBe(0);

    const nftIssues = await prisma.nftIssue.findMany({ where: { orderId: order.id } });
    expect(nftIssues).toHaveLength(2); // nftバリエーションの数量分のみ
    expect(nftIssues.every((n) => n.status === 'wallet_required')).toBe(true);

    // 同一イベントを再送 → 二重処理されない
    const res2 = await postWebhook(eventPayload);
    expect(res2.status).toBe(200);
    expect(res2.body.duplicate).toBe(true);

    const nftIssuesAfterRetry = await prisma.nftIssue.findMany({ where: { orderId: order.id } });
    expect(nftIssuesAfterRetry).toHaveLength(2);

    const variantAfterRetry = await prisma.productVariant.findUniqueOrThrow({ where: { id: nftVariantId } });
    expect(variantAfterRetry.stock).toBe(8);
  });

  // 本番安定化指示書Stage1: HTTP経路からDispatcherを分離。Webhookは決済確定・在庫確定・
  // NFT発行行/報酬/Job/Outbox作成までを完了して200を返すのみとし、外部Mint API・代理店連携API・
  // OVE送信を待たない。ここでは(1)Webhook処理中に即時ディスパッチ関数が一切呼ばれないこと、
  // (2)応答後もJob/NFT発行行が処理前の状態のまま残ること、を確認する
  // (Mint停止中でもWebhookが待たされないことの回帰確認)。
  it('Webhookは即時ディスパッチ関数を呼ばず、外部API・Mint停止中でも応答が遅延しない。Job/NFT発行行は応答後もpendingのまま残る', async () => {
    // 共有フィクスチャ(nftVariantId)は他のテストと在庫を分け合っているため、この専用テストでは
    // 自前の商品・バリエーションを使う(在庫の奪い合いを避ける)。
    const decoupledProduct = await prisma.product.create({
      data: {
        name: 'Webhookテスト評議員証(Stage1分離確認用)',
        slug: `webhook-test-decoupled-${Date.now()}`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 20000,
        status: 'published',
      },
    });
    const decoupledVariant = await prisma.productVariant.create({
      data: { productId: decoupledProduct.id, name: '通常', price: 20000, stock: 5, reservedStock: 0 },
    });

    const email = `webhook-test-decoupled-${Date.now()}@example.com`;
    const { order: createdOrder } = await createPendingOrder({
      customerName: 'Webhookテスト太郎',
      customerEmail: email,
      customerPhone: '090-0000-0000',
      customerPostalCode: '100-0001',
      customerAddress: '東京都千代田区1-1-1',
      agreedToTerms: true,
      items: [{ variantId: decoupledVariant.id, quantity: 1 }],
    });
    const sessionId = `cs_test_${Math.random().toString(36).slice(2)}`;
    await prisma.order.update({ where: { id: createdOrder.id }, data: { stripeSessionId: sessionId } });
    const order = createdOrder;
    const paymentIntentId = `pi_test_${Math.random().toString(36).slice(2)}`;
    const eventId = `evt_test_decoupled_${Date.now()}`;

    triggerImmediateNftMintProcessing.mockClear();
    triggerImmediateOrderLinkingDispatch.mockClear();
    triggerImmediateOutboxDispatch.mockClear();

    const startedAt = Date.now();
    const res = await postWebhook({
      id: eventId,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sessionId, payment_intent: paymentIntentId, metadata: { order_id: order.id } } },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(200);
    // 外部API呼び出しを一切待たないため、決済確定処理自体はミリ秒〜低百ミリ秒で終わるはず
    // (Mint API等が数秒〜数十秒応答しない状況を仮に再現しても、これらの関数を呼ばなくなった
    // 以上、応答時間には反映されない)。
    expect(elapsedMs).toBeLessThan(5000);

    expect(triggerImmediateNftMintProcessing).not.toHaveBeenCalled();
    expect(triggerImmediateOrderLinkingDispatch).not.toHaveBeenCalled();
    expect(triggerImmediateOutboxDispatch).not.toHaveBeenCalled();

    // NFT発行行(wallet_required)・注文紐付けJob(common_user_resolve等)は、応答後も
    // 処理前の状態のまま残る(Cronまたは管理者の明示的な再送を待つ)。
    const nftIssues = await prisma.nftIssue.findMany({ where: { orderId: order.id } });
    expect(nftIssues.length).toBeGreaterThan(0);
    expect(nftIssues.every((n) => n.status === 'wallet_required')).toBe(true);

    const orderLinkingJobs = await prisma.orderLinkingJob.findMany({ where: { orderId: order.id } });
    expect(orderLinkingJobs.every((j) => j.status === 'pending')).toBe(true);

    // このテスト専用に作った商品・注文の後片付け(共有フィクスチャのafterAllには含まれないため)。
    // ユーザー・password_reset_tokenはメールアドレスが'webhook-test'を含むため、
    // ファイル全体のafterAllで削除される(ON DELETE RESTRICTのため削除順を崩さない)。
    await prisma.orderLinkingJob.deleteMany({ where: { orderId: order.id } });
    await prisma.nftIssue.deleteMany({ where: { orderId: order.id } });
    await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
    await prisma.order.delete({ where: { id: order.id } });
    await prisma.productVariant.delete({ where: { id: decoupledVariant.id } });
    await prisma.product.delete({ where: { id: decoupledProduct.id } });
  });

  it('item_type != nft の商品ではnft_issuesが作られない', async () => {
    const email = `webhook-test-physicalonly-${Date.now()}@example.com`;
    const { order } = await createPendingOrder({
      customerName: 'テスト',
      customerEmail: email,
      customerPhone: '090-0000-0000',
      customerPostalCode: '100-0001',
      customerAddress: '東京都千代田区1-1-1',
      agreedToTerms: true,
      items: [{ variantId: physicalVariantId, quantity: 1 }],
    });
    const sessionId = `cs_test_${Math.random().toString(36).slice(2)}`;
    await prisma.order.update({ where: { id: order.id }, data: { stripeSessionId: sessionId } });

    await postWebhook({
      id: `evt_test_physical_${Date.now()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sessionId, payment_intent: `pi_test_${Date.now()}`, metadata: { order_id: order.id } } },
    });

    const nftIssues = await prisma.nftIssue.findMany({ where: { orderId: order.id } });
    expect(nftIssues).toHaveLength(0);
  });

  it('紹介コードありの場合commissionsが作成され報酬率が注文のスナップショット値と一致する', async () => {
    const referralLink = await prisma.referralLink.create({
      data: { code: `WHREF-${Date.now()}`, agencyId, landingPath: '/products/test' },
    });
    const email = `webhook-test-commission-${Date.now()}@example.com`;
    const { order, sessionId } = (await (async () => {
      const { order } = await createPendingOrder({
        customerName: 'テスト',
        customerEmail: email,
        customerPhone: '090-0000-0000',
        customerPostalCode: '100-0001',
        customerAddress: '東京都千代田区1-1-1',
        referralCode: referralLink.code,
        agreedToTerms: true,
        items: [{ variantId: nftVariantId, quantity: 1 }],
      });
      const sid = `cs_test_${Math.random().toString(36).slice(2)}`;
      await prisma.order.update({ where: { id: order.id }, data: { stripeSessionId: sid } });
      return { order, sessionId: sid };
    })())!;

    await postWebhook({
      id: `evt_test_commission_${Date.now()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sessionId, payment_intent: `pi_test_${Date.now()}`, metadata: { order_id: order.id } } },
    });

    const commission = await prisma.commission.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(Number(commission.commissionRate)).toBe(10);
    expect(commission.status).toBe('pending');

    const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updatedOrder.commissionStatus).toBe('pending');
    expect(updatedOrder.commissionAmount).toBe(commission.commissionAmount);
  });

  it('残課題指示書Stage5: 紹介コードありの決済確定でreferral_confirm_purchaseジョブが記録される(未決済時は記録しない)', async () => {
    const referralLink = await prisma.referralLink.create({
      data: { code: `WHREF-CONFIRM-${Date.now()}`, agencyId, landingPath: '/products/test' },
    });
    const email = `webhook-test-confirm-job-${Date.now()}@example.com`;
    const { order } = await createPendingOrder({
      customerName: 'テスト',
      customerEmail: email,
      customerPhone: '090-0000-0000',
      customerPostalCode: '100-0001',
      customerAddress: '東京都千代田区1-1-1',
      referralCode: referralLink.code,
      agreedToTerms: true,
      items: [{ variantId: physicalVariantId, quantity: 1 }],
    });
    const sessionId = `cs_test_${Math.random().toString(36).slice(2)}`;
    await prisma.order.update({ where: { id: order.id }, data: { stripeSessionId: sessionId } });

    // 未決済(Checkout作成直後)の時点ではreferral_confirm_purchaseジョブは記録されない
    // (未決済注文でconfirmしない、という受入条件そのもの)。
    const beforePayment = await prisma.orderLinkingJob.findMany({
      where: { orderId: order.id, jobType: 'referral_confirm_purchase' },
    });
    expect(beforePayment).toHaveLength(0);

    await postWebhook({
      id: `evt_test_confirm_job_${Date.now()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sessionId, payment_intent: `pi_test_${Date.now()}`, metadata: { order_id: order.id } } },
    });

    const afterPayment = await prisma.orderLinkingJob.findMany({
      where: { orderId: order.id, jobType: 'referral_confirm_purchase' },
    });
    expect(afterPayment).toHaveLength(1);
    expect(afterPayment[0].status).toBe('pending');

    await prisma.orderLinkingJob.deleteMany({ where: { orderId: order.id } });
    await prisma.referralLink.delete({ where: { id: referralLink.id } });
  });

  it('checkout.session.expiredで仮引当が解放される', async () => {
    const email = `webhook-test-expired-${Date.now()}@example.com`;
    const { order, sessionId } = await createTestOrder(email);

    await postWebhook({
      id: `evt_test_expired_${Date.now()}`,
      type: 'checkout.session.expired',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sessionId, metadata: { order_id: order.id } } },
    });

    const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updatedOrder.paymentStatus).toBe('expired');
    expect(updatedOrder.expiredAt).not.toBeNull();

    const nftVariant = await prisma.productVariant.findUniqueOrThrow({ where: { id: nftVariantId } });
    expect(nftVariant.reservedStock).toBe(0);
  });

  it('payment_intent.payment_failedで注文がfailedになる(在庫は解放しない)', async () => {
    const email = `webhook-test-failed-${Date.now()}@example.com`;
    const { order } = await createTestOrder(email);
    const paymentIntentId = `pi_test_${Math.random().toString(36).slice(2)}`;

    await postWebhook({
      id: `evt_test_failed_${Date.now()}`,
      type: 'payment_intent.payment_failed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: paymentIntentId, metadata: { order_id: order.id } } },
    });

    const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updatedOrder.paymentStatus).toBe('failed');

    const nftVariant = await prisma.productVariant.findUniqueOrThrow({ where: { id: nftVariantId } });
    expect(nftVariant.reservedStock).toBeGreaterThan(0);
  });

  it('charge.refunded(全額)でnft_issuesとcommissionsがcancelledになりordersと同期される', async () => {
    const referralLink = await prisma.referralLink.create({
      data: { code: `WHREF-FULL-${Date.now()}`, agencyId, landingPath: '/products/test' },
    });
    const email = `webhook-test-fullrefund-${Date.now()}@example.com`;
    const { order } = await createPendingOrder({
      customerName: 'テスト',
      customerEmail: email,
      customerPhone: '090-0000-0000',
      customerPostalCode: '100-0001',
      customerAddress: '東京都千代田区1-1-1',
      referralCode: referralLink.code,
      agreedToTerms: true,
      items: [{ variantId: nftVariantId, quantity: 1 }],
    });
    const sessionId = `cs_test_${Math.random().toString(36).slice(2)}`;
    const paymentIntentId = `pi_test_${Math.random().toString(36).slice(2)}`;
    await prisma.order.update({ where: { id: order.id }, data: { stripeSessionId: sessionId } });

    await postWebhook({
      id: `evt_test_precondition_${Date.now()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sessionId, payment_intent: paymentIntentId, metadata: { order_id: order.id } } },
    });

    const totalAmount = (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).totalAmount;

    await postWebhook({
      id: `evt_test_refund_full_${Date.now()}`,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `ch_test_${Date.now()}`,
          payment_intent: paymentIntentId,
          amount: totalAmount,
          amount_refunded: totalAmount,
        },
      },
    });

    const refundedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(refundedOrder.paymentStatus).toBe('refunded');
    expect(refundedOrder.orderStatus).toBe('refunded');
    expect(refundedOrder.refundedAt).not.toBeNull();
    expect(refundedOrder.commissionStatus).toBe('cancelled');

    const nftIssues = await prisma.nftIssue.findMany({ where: { orderId: order.id } });
    expect(nftIssues.every((n) => n.status === 'cancelled')).toBe(true);

    const commission = await prisma.commission.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(commission.status).toBe('cancelled');
  });

  it('charge.refunded(全額)でも外部Mint APIへ送信中(processing)のnft_issuesはcancelledにせず、要確認の注記のみ追加する(仕様書外の拡張)', async () => {
    const email = `webhook-test-fullrefund-processing-${Date.now()}@example.com`;
    const { order } = await createTestOrder(email);
    const paymentIntentId = `pi_test_${Math.random().toString(36).slice(2)}`;
    const sessionId = (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).stripeSessionId!;

    await postWebhook({
      id: `evt_test_precondition_processing_${Date.now()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sessionId, payment_intent: paymentIntentId, metadata: { order_id: order.id } } },
    });

    const nftIssue = await prisma.nftIssue.findFirstOrThrow({ where: { orderId: order.id } });
    await prisma.nftIssue.update({ where: { id: nftIssue.id }, data: { status: 'processing', providerRequestId: 'test-in-flight' } });

    const totalAmount = (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).totalAmount;

    await postWebhook({
      id: `evt_test_refund_full_processing_${Date.now()}`,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `ch_test_processing_${Date.now()}`,
          payment_intent: paymentIntentId,
          amount: totalAmount,
          amount_refunded: totalAmount,
        },
      },
    });

    const refundedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(refundedOrder.paymentStatus).toBe('refunded');

    const updatedIssue = await prisma.nftIssue.findUniqueOrThrow({ where: { id: nftIssue.id } });
    expect(updatedIssue.status).toBe('processing');
    expect(updatedIssue.adminNote).toContain('全額返金発生・発行処理中のため要手動確認');
  });

  it('charge.refunded(一部)は自動変更せずadmin_noteのみ記録する', async () => {
    const email = `webhook-test-partialrefund-${Date.now()}@example.com`;
    const { order } = await createTestOrder(email);
    const paymentIntentId = `pi_test_${Math.random().toString(36).slice(2)}`;
    const sessionId = (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).stripeSessionId!;

    await postWebhook({
      id: `evt_test_precondition_partial_${Date.now()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sessionId, payment_intent: paymentIntentId, metadata: { order_id: order.id } } },
    });

    await postWebhook({
      id: `evt_test_refund_partial_${Date.now()}`,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `ch_test_partial_${Date.now()}`,
          payment_intent: paymentIntentId,
          amount: 41000,
          amount_refunded: 1000,
        },
      },
    });

    const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updatedOrder.paymentStatus).toBe('paid');
    expect(updatedOrder.adminNote).toContain('一部返金検知');

    const nftIssues = await prisma.nftIssue.findMany({ where: { orderId: order.id } });
    expect(nftIssues.every((n) => n.status === 'wallet_required')).toBe(true);
  });

  // 仕様書外の拡張(千ノ国全体統合契約2026-07-21・Stripe Inbox冪等性修正の回帰テスト):
  // 旧実装は「event_idを先行INSERTした時点で処理済み扱い」にしていたため、その後の業務処理が
  // 失敗しても、Stripeが同一event_idで再送すると即座に「重複」として無視され、注文が永久に
  // 未確定のまま残る欠陥があった。failed_retryableとして記録済みのイベントを同一内容で再送すると、
  // 正しく再処理されて決済が確定することを確認する。
  it('前回の配信で業務処理が失敗した(failed_retryable)イベントを同一内容で再送すると、正しく再処理されて決済が確定する', async () => {
    const email = `webhook-test-retryrecovery-${Date.now()}@example.com`;
    // 他のテストと在庫プールを共有しているnftVariantId/createTestOrderは使わず、
    // このテスト専用の商品・バリエーションを用意して在庫不足によるフレークを避ける。
    const dedicatedVariant = await prisma.productVariant.create({
      data: { productId: nftProductId, name: `RetryRecoveryTest-${Date.now()}`, price: 20000, stock: 5, reservedStock: 0 },
    });
    const { order } = await createPendingOrder({
      customerName: 'Webhookテスト太郎',
      customerEmail: email,
      customerPhone: '090-0000-0000',
      customerPostalCode: '100-0001',
      customerAddress: '東京都千代田区1-1-1',
      agreedToTerms: true,
      items: [{ variantId: dedicatedVariant.id, quantity: 1 }],
    });
    const sessionId = `cs_test_${Math.random().toString(36).slice(2)}`;
    await prisma.order.update({ where: { id: order.id }, data: { stripeSessionId: sessionId } });
    const paymentIntentId = `pi_test_${Math.random().toString(36).slice(2)}`;
    const eventId = `evt_test_retryrecovery_${Date.now()}`;
    const eventPayload = {
      id: eventId,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sessionId, payment_intent: paymentIntentId, metadata: { order_id: order.id } } },
    };

    // 前回の配信で業務処理が一時的なエラーで失敗し、failed_retryableとして記録された状態を再現する。
    const { payload } = sign(eventPayload);
    await prisma.stripeEvent.create({
      data: {
        stripeEventId: eventId,
        eventType: 'checkout.session.completed',
        payloadHash: hashPayload(payload),
        status: 'failed_retryable',
        attemptCount: 1,
        lastError: 'テスト: 前回配信時の一時的な処理失敗を想定',
      },
    });

    const res = await postWebhook(eventPayload);
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBeUndefined();

    const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updatedOrder.paymentStatus).toBe('paid');

    const eventRow = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(eventRow.status).toBe('succeeded');
    expect(eventRow.attemptCount).toBe(2);
  });

  it('不正な署名は400を返す', async () => {
    const res = await request(app)
      .post('/api/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 't=1,v1=invalidsignature')
      .send(JSON.stringify({ id: 'evt_bad', type: 'checkout.session.completed' }));

    expect(res.status).toBe(400);
  });
});
