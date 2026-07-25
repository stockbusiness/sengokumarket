import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { confirmWalletClaim, getWalletClaimStatus } from './walletClaimConfirm';
import { hashClaimToken } from './walletClaim';

const ORDER_PREFIX = 'SG-CLAIMCONFIRMTEST-';
const PRODUCT_PREFIX = 'claim-confirm-test-product-';

async function createEligibleOrder(
  suffix: string,
  opts: { quantity?: number; commonUserId?: string | null; resolutionStatus?: string; paymentStatus?: string; orderStatus?: string } = {},
) {
  const product = await prisma.product.create({
    data: {
      name: `${PRODUCT_PREFIX}${suffix}`,
      slug: `${PRODUCT_PREFIX}${suffix}`,
      category: 'テスト',
      itemType: 'nft',
      basePrice: 10000,
      status: 'published',
      images: ['https://example.com/card.png'],
    },
  });
  const rule = await prisma.productIntegrationRule.create({
    data: {
      productId: product.id,
      entitlementTargetSystemKey: 'ove-wallet',
      entitlementType: 'digital_collectible',
      assetCode: 'SGK-CARD-001',
      enabled: true,
    },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `${ORDER_PREFIX}${suffix}`,
      totalAmount: 10000,
      originalAmount: 10000,
      paymentStatus: opts.paymentStatus ?? 'paid',
      orderStatus: opts.orderStatus ?? 'paid',
      customerName: 'Claim確認テスト太郎',
      customerEmail: `claim-confirm-test-${suffix}@example.com`,
      termsAgreedAt: new Date(),
      termsVersion: '2026-07-01',
      commonUserId: opts.commonUserId === undefined ? 'cu_test_00000001' : opts.commonUserId,
      commonUserResolutionStatus: opts.resolutionStatus ?? (opts.commonUserId === null ? 'unresolved' : 'resolved'),
    },
  });
  const orderItem = await prisma.orderItem.create({
    data: {
      orderId: order.id,
      productId: product.id,
      productName: product.name,
      itemType: 'nft',
      quantity: opts.quantity ?? 1,
      unitPrice: 10000,
      subtotal: 10000,
    },
  });
  const nftIssues = await Promise.all(
    Array.from({ length: opts.quantity ?? 1 }, (_, i) =>
      prisma.nftIssue.create({
        data: { orderId: order.id, orderItemId: orderItem.id, productId: product.id, status: 'wallet_required', serialNumber: i + 1 },
      }),
    ),
  );
  return { product, rule, order, orderItem, nftIssues };
}

async function createClaim(orderId: string, token: string, overrides: Partial<{ status: string; expiresAt: Date }> = {}) {
  return prisma.walletClaim.create({
    data: {
      orderId,
      tokenHash: hashClaimToken(token),
      status: overrides.status ?? 'PENDING',
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
    },
  });
}

async function cleanupOrder(orderId: string, productId: string) {
  const deliveries = await prisma.collectibleDelivery.findMany({ where: { walletClaim: { orderId } } });
  const outboxEventIds = deliveries.map((d) => d.outboxEventId).filter((id): id is string => !!id);
  await prisma.collectibleDelivery.deleteMany({ where: { walletClaim: { orderId } } });
  await prisma.integrationEventAttempt.deleteMany({ where: { outboxEventId: { in: outboxEventIds } } });
  await prisma.integrationOutboxEvent.deleteMany({ where: { id: { in: outboxEventIds } } });
  await prisma.walletClaimAuditLog.deleteMany({ where: { orderId } });
  await prisma.walletClaim.deleteMany({ where: { orderId } });
  await prisma.nftIssue.deleteMany({ where: { orderId } });
  await prisma.orderItem.deleteMany({ where: { orderId } });
  await prisma.order.deleteMany({ where: { id: orderId } });
  await prisma.productIntegrationRule.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { id: productId } });
}

describe('walletClaimConfirm: getWalletClaimStatus', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('存在しないトークンはnullを返す', async () => {
    const result = await getWalletClaimStatus('nonexistent-token');
    expect(result).toBeNull();
  });
});

describe('walletClaimConfirm: confirmWalletClaim', () => {
  const originalDeliveryFlag = process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY;

  beforeEach(() => {
    // dispatchのtriggerImmediateOutboxDispatch自体はSENNOKUNI_INTEGRATION_ENABLEDに従いno-opの
    // ため、ここでは有効化しない(このテストの関心はDelivery・Outbox行の作成そのもの)。
    delete process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY;
  });

  afterEach(() => {
    process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY = originalDeliveryFlag;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('存在しないトークンはnot_foundを返す', async () => {
    const outcome = await confirmWalletClaim('nonexistent-token', { oveAccountId: 'ove-1', commonUserId: 'cu_test_00000001' });
    expect(outcome.kind).toBe('not_found');
  });

  it('common_user_idが一致する場合、quantity分のCollectibleDelivery・Outbox(quantity=1・entitlement_id固有)を作成しDELIVERY_PENDINGへ進む', async () => {
    const { order, product, nftIssues } = await createEligibleOrder('quantity-2', { quantity: 2 });
    const token = 'raw-token-quantity-2';
    await createClaim(order.id, token);

    const outcome = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_test_00000001' });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.status).toBe('DELIVERY_PENDING');

    const claim = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(claim.status).toBe('DELIVERY_PENDING');
    expect(claim.commonUserId).toBe('cu_test_00000001');
    expect(claim.oveAccountId).toBe('ove-acc-1');

    const deliveries = await prisma.collectibleDelivery.findMany({ where: { walletClaimId: claim.id } });
    expect(deliveries).toHaveLength(2);
    const entitlementIds = deliveries.map((d) => d.entitlementId).sort();
    expect(entitlementIds).toEqual([...nftIssues.map((n) => n.id)].sort());
    for (const delivery of deliveries) {
      expect(delivery.status).toBe('PENDING');
      expect(delivery.outboxEventId).not.toBeNull();
      const outboxEvent = await prisma.integrationOutboxEvent.findUniqueOrThrow({ where: { id: delivery.outboxEventId! } });
      const payload = outboxEvent.deliveryPayload as Record<string, unknown>;
      expect(payload.quantity).toBe(1);
      expect(payload.entitlement_id).toBe(delivery.nftIssueId);
    }

    await cleanupOrder(order.id, product.id);
  });

  it('common_user_idが一致しない場合、409相当(common_user_mismatch)を返しClaim・Deliveryを変更しない', async () => {
    const { order, product } = await createEligibleOrder('mismatch');
    const token = 'raw-token-mismatch';
    await createClaim(order.id, token);

    const outcome = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_someone_else' });
    expect(outcome.kind).toBe('common_user_mismatch');

    const claim = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(claim.status).toBe('PENDING');
    const deliveries = await prisma.collectibleDelivery.findMany({ where: { walletClaimId: claim.id } });
    expect(deliveries).toHaveLength(0);
    const auditLogs = await prisma.walletClaimAuditLog.findMany({ where: { orderId: order.id, eventType: 'common_user_mismatch' } });
    expect(auditLogs).toHaveLength(1);

    await cleanupOrder(order.id, product.id);
  });

  it('common_user_idが未解決の場合、保留(common_user_unresolved)としClaim状態を維持する', async () => {
    const { order, product } = await createEligibleOrder('unresolved', { commonUserId: null });
    const token = 'raw-token-unresolved';
    await createClaim(order.id, token);

    const outcome = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_test_00000001' });
    expect(outcome.kind).toBe('common_user_unresolved');

    const claim = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(claim.status).toBe('PENDING');
    const deliveries = await prisma.collectibleDelivery.findMany({ where: { walletClaimId: claim.id } });
    expect(deliveries).toHaveLength(0);

    await cleanupOrder(order.id, product.id);
  });

  it('期限切れのClaimはexpiredを返しEXPIREDへ遷移する', async () => {
    const { order, product } = await createEligibleOrder('expired');
    const token = 'raw-token-expired';
    await createClaim(order.id, token, { expiresAt: new Date(Date.now() - 1000) });

    const outcome = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_test_00000001' });
    expect(outcome.kind).toBe('expired');

    const claim = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(claim.status).toBe('EXPIRED');

    await cleanupOrder(order.id, product.id);
  });

  it('REVOKEDのClaimはrevokedを返す', async () => {
    const { order, product } = await createEligibleOrder('revoked');
    const token = 'raw-token-revoked';
    await createClaim(order.id, token, { status: 'REVOKED' });

    const outcome = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_test_00000001' });
    expect(outcome.kind).toBe('revoked');

    await cleanupOrder(order.id, product.id);
  });

  it('未決済の注文はorder_not_paidを返しClaimをERRORへ(再試行可能に)する', async () => {
    const { order, product } = await createEligibleOrder('not-paid', { paymentStatus: 'pending', orderStatus: 'pending' });
    const token = 'raw-token-not-paid';
    await createClaim(order.id, token);

    const outcome = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_test_00000001' });
    expect(outcome.kind).toBe('order_not_paid');

    const claim = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(claim.status).toBe('ERROR');

    await cleanupOrder(order.id, product.id);
  });

  it('返金済みの注文はorder_refundedを返しClaimをREVOKEDにする', async () => {
    const { order, product } = await createEligibleOrder('refunded', { paymentStatus: 'refunded', orderStatus: 'refunded' });
    const token = 'raw-token-refunded';
    await createClaim(order.id, token);

    const outcome = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_test_00000001' });
    expect(outcome.kind).toBe('order_refunded');

    const claim = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(claim.status).toBe('REVOKED');

    await cleanupOrder(order.id, product.id);
  });

  it('既にDELIVERY_PENDINGの状態で同一common_user_idの再確認は重複作成せずokを返す(冪等性)', async () => {
    const { order, product } = await createEligibleOrder('idempotent');
    const token = 'raw-token-idempotent';
    await createClaim(order.id, token);

    const first = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_test_00000001' });
    expect(first.kind).toBe('ok');
    const deliveriesAfterFirst = await prisma.collectibleDelivery.findMany({ where: { walletClaim: { orderId: order.id } } });

    const second = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_test_00000001' });
    expect(second.kind).toBe('ok');
    const deliveriesAfterSecond = await prisma.collectibleDelivery.findMany({ where: { walletClaim: { orderId: order.id } } });
    expect(deliveriesAfterSecond).toHaveLength(deliveriesAfterFirst.length);

    await cleanupOrder(order.id, product.id);
  });

  it('既にDELIVERY_PENDINGの状態で異なるcommon_user_idでの再確認はmismatchとして拒否する', async () => {
    const { order, product } = await createEligibleOrder('idempotent-mismatch');
    const token = 'raw-token-idempotent-mismatch';
    await createClaim(order.id, token);

    const first = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_test_00000001' });
    expect(first.kind).toBe('ok');

    const second = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_someone_else' });
    expect(second.kind).toBe('common_user_mismatch');

    await cleanupOrder(order.id, product.id);
  });
});
