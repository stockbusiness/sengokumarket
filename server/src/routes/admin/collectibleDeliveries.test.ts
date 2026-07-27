import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';
import { enqueueDigitalCollectibleEvent } from '../../services/integrationOutbox';

vi.mock('../../services/integrationOutboxDispatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/integrationOutboxDispatcher')>();
  return actual;
});

const app = createApp();
const PRODUCT_PREFIX = 'admin-cd-route-test-product-';
const ORDER_PREFIX = 'SG-ADMINCDTEST-';

async function createFixture(suffix: string, deliveryStatus = 'PENDING') {
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
  const order = await prisma.order.create({
    data: {
      orderNumber: `${ORDER_PREFIX}${suffix}`,
      totalAmount: 10000,
      originalAmount: 10000,
      paymentStatus: 'paid',
      orderStatus: 'paid',
      customerName: '管理画面Deliveryテスト太郎',
      customerEmail: `admin-cd-test-${suffix}@example.com`,
      termsAgreedAt: new Date(),
      termsVersion: '2026-07-01',
      commonUserId: 'cu_test_00000001',
      commonUserResolutionStatus: 'resolved',
    },
  });
  const orderItem = await prisma.orderItem.create({
    data: { orderId: order.id, productId: product.id, productName: product.name, itemType: 'nft', quantity: 1, unitPrice: 10000, subtotal: 10000 },
  });
  const nftIssue = await prisma.nftIssue.create({
    data: { orderId: order.id, orderItemId: orderItem.id, productId: product.id, status: 'wallet_required', serialNumber: 1 },
  });
  const claim = await prisma.walletClaim.create({
    data: {
      orderId: order.id,
      tokenHash: `admin-cd-hash-${suffix}`,
      status: 'DELIVERY_PENDING',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
      commonUserId: 'cu_test_00000001',
    },
  });
  const claimItem = await prisma.walletClaimItem.create({
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
  const outboxEventId = await prisma.$transaction((tx) =>
    enqueueDigitalCollectibleEvent(tx, {
      order,
      orderItem,
      nftIssue,
      claimItem,
      commonUserId: 'cu_test_00000001',
      eventType: 'entitlement.granted',
    }),
  );
  if (deliveryStatus !== 'PENDING') {
    await prisma.integrationOutboxEvent.update({ where: { id: outboxEventId }, data: { status: deliveryStatus === 'DEAD' ? 'dead' : 'pending' } });
  }
  const delivery = await prisma.collectibleDelivery.create({
    data: {
      walletClaimId: claim.id,
      nftIssueId: nftIssue.id,
      entitlementId: nftIssue.id,
      commonUserId: 'cu_test_00000001',
      oveAccountId: 'ove-acc-1',
      status: deliveryStatus,
      outboxEventId,
    },
  });
  return { product, order, orderItem, nftIssue, claim, delivery, outboxEventId };
}

async function cleanup(orderId: string, productId: string, outboxEventId: string) {
  await prisma.collectibleDelivery.deleteMany({ where: { walletClaim: { orderId } } });
  await prisma.walletClaimItem.deleteMany({ where: { walletClaim: { orderId } } });
  await prisma.walletClaim.deleteMany({ where: { orderId } });
  await prisma.integrationEventAttempt.deleteMany({ where: { outboxEventId } });
  await prisma.integrationOutboxEvent.deleteMany({ where: { id: outboxEventId } });
  await prisma.nftIssue.deleteMany({ where: { orderId } });
  await prisma.orderItem.deleteMany({ where: { orderId } });
  await prisma.order.deleteMany({ where: { id: orderId } });
  await prisma.productIntegrationRule.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { id: productId } });
}

describe('管理API: /admin/collectible-deliveries(戦国マーケットNFTカード受取・送付19章)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('未認証は401', async () => {
    const res = await request(app).get('/api/admin/collectible-deliveries');
    expect(res.status).toBe(401);
  });

  it('管理者は一覧取得・entitlement_id/nft_issue_idで絞り込みできる', async () => {
    const { agent } = await createAdminAgent(app);
    const { order, product, delivery, outboxEventId } = await createFixture(`list-${Date.now()}`);

    const res = await agent.get(`/api/admin/collectible-deliveries?entitlementId=${delivery.entitlementId}`);
    expect(res.status).toBe(200);
    expect(res.body.collectibleDeliveries).toHaveLength(1);
    expect(res.body.collectibleDeliveries[0].nftIssueId).toBe(delivery.nftIssueId);

    await cleanup(order.id, product.id, outboxEventId);
  });

  it('詳細取得でOutboxの試行履歴を含む', async () => {
    const { agent } = await createAdminAgent(app);
    const { order, product, delivery, outboxEventId } = await createFixture(`detail-${Date.now()}`);

    const res = await agent.get(`/api/admin/collectible-deliveries/${delivery.id}`);
    expect(res.status).toBe(200);
    expect(res.body.collectibleDelivery.entitlementId).toBe(delivery.entitlementId);
    expect(Array.isArray(res.body.collectibleDelivery.attempts)).toBe(true);

    await cleanup(order.id, product.id, outboxEventId);
  });

  it('DELIVEREDのDeliveryは再送できない(直接巻き戻し禁止・19章)', async () => {
    const { agent } = await createAdminAgent(app);
    const { order, product, delivery, outboxEventId } = await createFixture(`no-retry-${Date.now()}`, 'DELIVERED');

    const res = await agent.post(`/api/admin/collectible-deliveries/${delivery.id}/retry`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(400);

    await cleanup(order.id, product.id, outboxEventId);
  });

  it('DEADのDeliveryは再送を試みられる', async () => {
    const { agent } = await createAdminAgent(app);
    const { order, product, delivery, outboxEventId } = await createFixture(`retry-dead-${Date.now()}`, 'DEAD');

    const res = await agent.post(`/api/admin/collectible-deliveries/${delivery.id}/retry`).set('Origin', TEST_ORIGIN);
    // SENNOKUNI_INTEGRATION_ENABLED未設定(既定false)のためretryOutboxEvent自体はok:falseを
    // 返す(Feature Flag無効時は手動再送であっても実送信しない、という既存の一貫方針)。
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RETRY_FAILED');

    await cleanup(order.id, product.id, outboxEventId);
  });

  it('スタッフ(staff)はこの画面にアクセスできない(403)', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    const email = `admin-cd-staff-test-${Date.now()}@example.com`;
    await prisma.user.create({ data: { name: 'スタッフ', email, passwordHash: await bcrypt.hash('staffpassword1', 10), role: 'staff' } });
    const agent = request.agent(app);
    await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'staffpassword1' });

    const res = await agent.get('/api/admin/collectible-deliveries');
    expect(res.status).toBe(403);

    await prisma.user.deleteMany({ where: { email } });
  });
});
