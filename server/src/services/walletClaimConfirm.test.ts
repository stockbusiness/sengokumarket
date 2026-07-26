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

// Wallet Claim本番前安定化指示書(2026-07-25)Phase4: 本番ではcreateWalletClaimIfEligibleが
// 決済確定時にWalletClaimItem(購入時点のルール・商品スナップショット)を同一トランザクションで
// 作成する。confirmWalletClaimはこのWalletClaimItemのみを基準に送付対象を判断するため、この
// テスト用ヘルパーも呼び出し時点の(現在の)ルール状態からWalletClaimItemを作成する。
async function createClaim(
  fixture: Awaited<ReturnType<typeof createEligibleOrder>>,
  token: string,
  overrides: Partial<{ status: string; expiresAt: Date }> = {},
) {
  const claim = await prisma.walletClaim.create({
    data: {
      orderId: fixture.order.id,
      tokenHash: hashClaimToken(token),
      status: overrides.status ?? 'PENDING',
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
    },
  });

  const currentRule = await prisma.productIntegrationRule.findFirst({
    where: { productId: fixture.product.id, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', enabled: true },
  });
  if (currentRule) {
    await prisma.walletClaimItem.createMany({
      data: fixture.nftIssues.map((nftIssue) => ({
        walletClaimId: claim.id,
        nftIssueId: nftIssue.id,
        orderItemId: fixture.orderItem.id,
        productId: fixture.product.id,
        productIntegrationRuleId: currentRule.id,
        destinationSystemKey: currentRule.entitlementTargetSystemKey!,
        entitlementType: currentRule.entitlementType!,
        assetCode: currentRule.assetCode,
        serialNumber: nftIssue.serialNumber,
        name: fixture.product.name,
        description: fixture.product.description,
        imageUrl: fixture.product.images[0] ?? null,
        thumbnailUrl: fixture.product.images[0] ?? null,
        rarity: currentRule.collectibleRarity,
      })),
    });
  }
  return claim;
}

async function cleanupOrder(orderId: string, productId: string) {
  const deliveries = await prisma.collectibleDelivery.findMany({ where: { walletClaim: { orderId } } });
  const outboxEventIds = deliveries.map((d) => d.outboxEventId).filter((id): id is string => !!id);
  await prisma.collectibleDelivery.deleteMany({ where: { walletClaim: { orderId } } });
  await prisma.integrationEventAttempt.deleteMany({ where: { outboxEventId: { in: outboxEventIds } } });
  await prisma.integrationOutboxEvent.deleteMany({ where: { id: { in: outboxEventIds } } });
  await prisma.walletClaimAuditLog.deleteMany({ where: { orderId } });
  await prisma.walletClaimItem.deleteMany({ where: { walletClaim: { orderId } } });
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
    const fixture = await createEligibleOrder('quantity-2', { quantity: 2 });
    const { order, product, nftIssues } = fixture;
    const token = 'raw-token-quantity-2';
    await createClaim(fixture, token);

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
    const fixture = await createEligibleOrder('mismatch');
    const { order, product } = fixture;
    const token = 'raw-token-mismatch';
    await createClaim(fixture, token);

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
    const fixture = await createEligibleOrder('unresolved', { commonUserId: null });
    const { order, product } = fixture;
    const token = 'raw-token-unresolved';
    await createClaim(fixture, token);

    const outcome = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_test_00000001' });
    expect(outcome.kind).toBe('common_user_unresolved');

    const claim = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(claim.status).toBe('PENDING');
    const deliveries = await prisma.collectibleDelivery.findMany({ where: { walletClaimId: claim.id } });
    expect(deliveries).toHaveLength(0);

    await cleanupOrder(order.id, product.id);
  });

  it('期限切れのClaimはexpiredを返しEXPIREDへ遷移する', async () => {
    const fixture = await createEligibleOrder('expired');
    const { order, product } = fixture;
    const token = 'raw-token-expired';
    await createClaim(fixture, token, { expiresAt: new Date(Date.now() - 1000) });

    const outcome = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_test_00000001' });
    expect(outcome.kind).toBe('expired');

    const claim = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(claim.status).toBe('EXPIRED');

    await cleanupOrder(order.id, product.id);
  });

  it('REVOKEDのClaimはrevokedを返す', async () => {
    const fixture = await createEligibleOrder('revoked');
    const { order, product } = fixture;
    const token = 'raw-token-revoked';
    await createClaim(fixture, token, { status: 'REVOKED' });

    const outcome = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_test_00000001' });
    expect(outcome.kind).toBe('revoked');

    await cleanupOrder(order.id, product.id);
  });

  it('未決済の注文はorder_not_paidを返しClaimをERRORへ(再試行可能に)する', async () => {
    const fixture = await createEligibleOrder('not-paid', { paymentStatus: 'pending', orderStatus: 'pending' });
    const { order, product } = fixture;
    const token = 'raw-token-not-paid';
    await createClaim(fixture, token);

    const outcome = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_test_00000001' });
    expect(outcome.kind).toBe('order_not_paid');

    const claim = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(claim.status).toBe('ERROR');

    await cleanupOrder(order.id, product.id);
  });

  it('返金済みの注文はorder_refundedを返しClaimをREVOKEDにする', async () => {
    const fixture = await createEligibleOrder('refunded', { paymentStatus: 'refunded', orderStatus: 'refunded' });
    const { order, product } = fixture;
    const token = 'raw-token-refunded';
    await createClaim(fixture, token);

    const outcome = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_test_00000001' });
    expect(outcome.kind).toBe('order_refunded');

    const claim = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(claim.status).toBe('REVOKED');

    await cleanupOrder(order.id, product.id);
  });

  it('既にDELIVERY_PENDINGの状態で同一common_user_idの再確認は重複作成せずokを返す(冪等性)', async () => {
    const fixture = await createEligibleOrder('idempotent');
    const { order, product } = fixture;
    const token = 'raw-token-idempotent';
    await createClaim(fixture, token);

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
    const fixture = await createEligibleOrder('idempotent-mismatch');
    const { order, product } = fixture;
    const token = 'raw-token-idempotent-mismatch';
    await createClaim(fixture, token);

    const first = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_test_00000001' });
    expect(first.kind).toBe('ok');

    const second = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_someone_else' });
    expect(second.kind).toBe('common_user_mismatch');

    await cleanupOrder(order.id, product.id);
  });

  it('ok結果はdelivery_countとしてquantity分の作成件数を返す', async () => {
    const fixture = await createEligibleOrder('delivery-count', { quantity: 3 });
    const { order, product } = fixture;
    const token = 'raw-token-delivery-count';
    await createClaim(fixture, token);

    const outcome = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_test_00000001' });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.deliveryCount).toBe(3);

    await cleanupOrder(order.id, product.id);
  });

  // Wallet Claim本番前安定化指示書(2026-07-25)6.5「Delivery 0件」: ProductIntegrationRuleが
  // 未設定(digital_collectible対象外)のNftIssueしか存在しない場合、DELIVERY_PENDINGへ進めず
  // ERROR(要確認)のまま留める。
  it('送付対象NftIssueが1件も無い場合、no_claimable_itemsを返しClaimをERRORのまま留める', async () => {
    const fixture = await createEligibleOrder('no-claimable');
    const { order, product, rule } = fixture;
    await prisma.productIntegrationRule.update({ where: { id: rule.id }, data: { enabled: false } });
    const token = 'raw-token-no-claimable';
    await createClaim(fixture, token);

    const outcome = await confirmWalletClaim(token, { oveAccountId: 'ove-acc-1', commonUserId: 'cu_test_00000001' });
    expect(outcome.kind).toBe('no_claimable_items');

    const claim = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(claim.status).toBe('ERROR');
    expect(claim.lastError).toBe('no_claimable_items');
    const deliveries = await prisma.collectibleDelivery.findMany({ where: { walletClaimId: claim.id } });
    expect(deliveries).toHaveLength(0);

    await cleanupOrder(order.id, product.id);
  });
});
