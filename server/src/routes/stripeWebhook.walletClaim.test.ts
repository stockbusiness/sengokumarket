import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { setSetting } from '../services/settings';

// 本番安定化指示書Stage1と同じ方針: Webhook応答経路の外部API待ちを避けるため即時ディスパッチはmockする。
vi.mock('../services/nftMintProcessing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/nftMintProcessing')>();
  return { ...actual, triggerImmediateNftMintProcessing: async () => {} };
});
vi.mock('../services/orderLinkingJobDispatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/orderLinkingJobDispatcher')>();
  return { ...actual, triggerImmediateOrderLinkingDispatch: async () => {} };
});
vi.mock('../services/integrationOutboxDispatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/integrationOutboxDispatcher')>();
  return { ...actual, triggerImmediateOutboxDispatch: async () => {} };
});

const app = createApp();
const WEBHOOK_SECRET = 'whsec_test_wallet_claim_refund';
const PRODUCT_PREFIX = 'wc-refund-test-product-';
const ORDER_PREFIX = 'SG-WCREFUNDTEST-';

function sign(payloadObj: unknown) {
  const payload = JSON.stringify(payloadObj);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, header };
}

async function postWebhook(payloadObj: unknown) {
  const { payload, header } = sign(payloadObj);
  return request(app).post('/api/stripe/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', header).send(payload);
}

async function postFullRefund(paymentIntentId: string, amount: number) {
  return postWebhook({
    id: `evt_test_wc_refund_${Math.random().toString(36).slice(2)}`,
    type: 'charge.refunded',
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: `ch_test_${Math.random().toString(36).slice(2)}`, payment_intent: paymentIntentId, amount, amount_refunded: amount } },
  });
}

async function createFixture(
  suffix: string,
  opts: { claimStatus: string; nftIssueStatus?: string; deliveryStatus?: string; withDelivery?: boolean },
) {
  const product = await prisma.product.create({
    data: {
      name: `${PRODUCT_PREFIX}${suffix}`,
      slug: `${PRODUCT_PREFIX}${suffix}`,
      category: 'テスト',
      itemType: 'nft',
      basePrice: 10000,
      status: 'published',
    },
  });
  const rule = await prisma.productIntegrationRule.create({
    data: { productId: product.id, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', enabled: true },
  });
  const paymentIntentId = `pi_test_wc_${suffix}_${Math.random().toString(36).slice(2)}`;
  const order = await prisma.order.create({
    data: {
      orderNumber: `${ORDER_PREFIX}${suffix}`,
      totalAmount: 10000,
      originalAmount: 10000,
      paymentStatus: 'paid',
      orderStatus: 'paid',
      customerName: '返金テスト太郎',
      customerEmail: `wc-refund-test-${suffix}@example.com`,
      termsAgreedAt: new Date(),
      termsVersion: '2026-07-01',
      stripePaymentIntentId: paymentIntentId,
      commonUserId: 'cu_test_00000001',
      commonUserResolutionStatus: 'resolved',
    },
  });
  const orderItem = await prisma.orderItem.create({
    data: { orderId: order.id, productId: product.id, productName: product.name, itemType: 'nft', quantity: 1, unitPrice: 10000, subtotal: 10000 },
  });
  const nftIssue = await prisma.nftIssue.create({
    data: { orderId: order.id, orderItemId: orderItem.id, productId: product.id, status: opts.nftIssueStatus ?? 'wallet_required', serialNumber: 1 },
  });
  const claim = await prisma.walletClaim.create({
    data: {
      orderId: order.id,
      tokenHash: `hash-${suffix}`,
      status: opts.claimStatus,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
      commonUserId: opts.claimStatus !== 'PENDING' ? 'cu_test_00000001' : null,
    },
  });
  // Wallet Claim本番前安定化指示書(2026-07-25)Phase4: walletClaimRefundは返金時のentitlement.revoked
  // enqueueをWalletClaimItem(購入時点のスナップショット)経由で行うため、このテスト用フィクスチャでも
  // 同時に作成する。
  await prisma.walletClaimItem.create({
    data: {
      walletClaimId: claim.id,
      nftIssueId: nftIssue.id,
      orderItemId: orderItem.id,
      productId: product.id,
      productIntegrationRuleId: rule.id,
      destinationSystemKey: rule.entitlementTargetSystemKey!,
      entitlementType: rule.entitlementType!,
      name: product.name,
    },
  });
  let delivery = null;
  if (opts.withDelivery) {
    delivery = await prisma.collectibleDelivery.create({
      data: {
        walletClaimId: claim.id,
        nftIssueId: nftIssue.id,
        entitlementId: nftIssue.id,
        commonUserId: 'cu_test_00000001',
        oveAccountId: 'ove-acc-1',
        status: opts.deliveryStatus ?? 'PENDING',
        ...(opts.deliveryStatus === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
      },
    });
  }
  return { product, order, orderItem, nftIssue, claim, delivery, paymentIntentId };
}

async function cleanup(orderId: string, productId: string) {
  const deliveries = await prisma.collectibleDelivery.findMany({ where: { walletClaim: { orderId } } });
  const outboxEventIds = deliveries.map((d) => d.outboxEventId).filter((id): id is string => !!id);
  const otherOutboxEvents = await prisma.integrationOutboxEvent.findMany({ where: { correlationId: orderId } });
  const allOutboxEventIds = [...new Set([...outboxEventIds, ...otherOutboxEvents.map((e) => e.id)])];
  await prisma.collectibleDelivery.deleteMany({ where: { walletClaim: { orderId } } });
  await prisma.walletClaimAuditLog.deleteMany({ where: { orderId } });
  await prisma.walletClaimItem.deleteMany({ where: { walletClaim: { orderId } } });
  await prisma.walletClaim.deleteMany({ where: { orderId } });
  await prisma.integrationEventAttempt.deleteMany({ where: { outboxEventId: { in: allOutboxEventIds } } });
  await prisma.integrationOutboxEvent.deleteMany({ where: { id: { in: allOutboxEventIds } } });
  await prisma.nftIssue.deleteMany({ where: { orderId } });
  await prisma.orderItem.deleteMany({ where: { orderId } });
  await prisma.order.deleteMany({ where: { id: orderId } });
  await prisma.productIntegrationRule.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { id: productId } });
}

describe('charge.refunded: WalletClaim/CollectibleDeliveryの段階別取消(戦国マーケットNFTカード受取・送付16章)', () => {
  beforeAll(async () => {
    await setSetting('stripe_webhook_secret', WEBHOOK_SECRET);
  });

  beforeEach(() => {
    process.env.ENABLE_WALLET_CLAIM = 'true';
  });

  afterEach(() => {
    delete process.env.ENABLE_WALLET_CLAIM;
  });

  afterAll(async () => {
    await prisma.setting.deleteMany({ where: { key: 'stripe_webhook_secret' } });
    await prisma.$disconnect();
  });

  it('Claim前(PENDING)の返金でWalletClaim=REVOKEDになる', async () => {
    const { order, product, paymentIntentId } = await createFixture('claim-before', { claimStatus: 'PENDING' });
    const res = await postFullRefund(paymentIntentId, 10000);
    expect(res.status).toBe(200);

    const claim = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(claim.status).toBe('REVOKED');

    await cleanup(order.id, product.id);
  });

  it('Claim後・送付前(DELIVERY_PENDING)の返金で未送付CollectibleDeliveryがREVOKED・WalletClaimもREVOKEDになる', async () => {
    const { order, product, claim, delivery, paymentIntentId } = await createFixture('claim-after-before-delivery', {
      claimStatus: 'DELIVERY_PENDING',
      withDelivery: true,
      deliveryStatus: 'PENDING',
    });
    const res = await postFullRefund(paymentIntentId, 10000);
    expect(res.status).toBe(200);

    const updatedClaim = await prisma.walletClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(updatedClaim.status).toBe('REVOKED');
    const updatedDelivery = await prisma.collectibleDelivery.findUniqueOrThrow({ where: { id: delivery!.id } });
    expect(updatedDelivery.status).toBe('REVOKED');
    expect(updatedDelivery.revokedAt).not.toBeNull();

    await cleanup(order.id, product.id);
  });

  it('送付後・Mint前(DELIVERED状態のNftIssueが未Mint)の返金でNftIssue単位のentitlement.revokedイベントがenqueueされる', async () => {
    const { order, product, nftIssue, delivery, paymentIntentId } = await createFixture('delivered-pre-mint', {
      claimStatus: 'DELIVERED',
      nftIssueStatus: 'ready_to_issue',
      withDelivery: true,
      deliveryStatus: 'DELIVERED',
    });
    const res = await postFullRefund(paymentIntentId, 10000);
    expect(res.status).toBe(200);

    const events = await prisma.integrationOutboxEvent.findMany({ where: { eventType: 'entitlement.revoked', destinationSystemKey: 'ove-wallet' } });
    const matching = events.find((e) => (e.deliveryPayload as Record<string, unknown>).nft_issue_id === nftIssue.id);
    expect(matching).toBeTruthy();
    expect((matching!.deliveryPayload as Record<string, unknown>).entitlement_type).toBe('digital_collectible');

    // Wallet Claim本番前安定化指示書(2026-07-25)Phase6(8.2・8.3): 取消送信を開始した時点で
    // WalletClaimはDELIVEREDのまま残さずREVOCATION_PENDINGへ進める。
    const updatedClaim = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(updatedClaim.status).toBe('REVOCATION_PENDING');

    // 最終安定化指示書Phase1: syncCollectibleDeliveryOnSendはoutbox_event_id基準でDeliveryを
    // 検索するため、新しく作った取消イベントへ張り替わっていないと取消送信が成功しても
    // このDeliveryへ反映されない(=WalletClaimがREVOCATION_PENDINGのまま滞留するバグ)。
    const updatedDelivery = await prisma.collectibleDelivery.findUniqueOrThrow({ where: { id: delivery!.id } });
    expect(updatedDelivery.outboxEventId).toBe(matching!.id);

    await cleanup(order.id, product.id);
  });

  it('Mint後(issued)の返金は自動処理せず、NftIssueにmanual_review_requiredの注記のみ追加しWalletClaimをMANUAL_REVIEW_REQUIREDへ進める', async () => {
    const { order, product, nftIssue, paymentIntentId } = await createFixture('mint-completed', {
      claimStatus: 'DELIVERED',
      nftIssueStatus: 'issued',
      withDelivery: true,
      deliveryStatus: 'DELIVERED',
    });
    const res = await postFullRefund(paymentIntentId, 10000);
    expect(res.status).toBe(200);

    const updatedIssue = await prisma.nftIssue.findUniqueOrThrow({ where: { id: nftIssue.id } });
    expect(updatedIssue.status).toBe('issued'); // 変更しない
    expect(updatedIssue.adminNote).toContain('manual_review_required');

    const events = await prisma.integrationOutboxEvent.findMany({ where: { eventType: 'entitlement.revoked', destinationSystemKey: 'ove-wallet' } });
    const matching = events.find((e) => (e.deliveryPayload as Record<string, unknown>).nft_issue_id === nftIssue.id);
    expect(matching).toBeFalsy();

    const updatedClaim = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(updatedClaim.status).toBe('MANUAL_REVIEW_REQUIRED');
    expect(updatedClaim.manualReviewRequiredAt).not.toBeNull();

    await cleanup(order.id, product.id);
  });

  it('二重返金でも同一イベントを重複enqueueしない(REVOCATION_PENDING/MANUAL_REVIEW_REQUIREDへ到達後は何もしない)', async () => {
    const { order, product, nftIssue, paymentIntentId } = await createFixture('double-refund', {
      claimStatus: 'DELIVERED',
      nftIssueStatus: 'ready_to_issue',
      withDelivery: true,
      deliveryStatus: 'DELIVERED',
    });
    const firstRes = await postFullRefund(paymentIntentId, 10000);
    expect(firstRes.status).toBe(200);

    const eventsAfterFirst = await prisma.integrationOutboxEvent.findMany({
      where: { eventType: 'entitlement.revoked', destinationSystemKey: 'ove-wallet' },
    });
    const matchingAfterFirst = eventsAfterFirst.filter((e) => (e.deliveryPayload as Record<string, unknown>).nft_issue_id === nftIssue.id);
    expect(matchingAfterFirst).toHaveLength(1);

    // 同一paymentIntentId・全額返金分のcharge.refundedイベントがStripe側の再送等でもう一度届いても
    // (order.paymentStatusは既に'refunded'のため、そもそもapplyWalletClaimRefundEffects到達前の
    // hendleChargeRefunded側のガードで弾かれるが)、念のためClaim状態面でも冪等であることを確認する。
    const secondRes = await postFullRefund(paymentIntentId, 10000);
    expect(secondRes.status).toBe(200);

    const eventsAfterSecond = await prisma.integrationOutboxEvent.findMany({
      where: { eventType: 'entitlement.revoked', destinationSystemKey: 'ove-wallet' },
    });
    const matchingAfterSecond = eventsAfterSecond.filter((e) => (e.deliveryPayload as Record<string, unknown>).nft_issue_id === nftIssue.id);
    expect(matchingAfterSecond).toHaveLength(1);

    await cleanup(order.id, product.id);
  });
});
