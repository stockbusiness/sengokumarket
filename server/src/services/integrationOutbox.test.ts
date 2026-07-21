import crypto from 'crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { enqueueEntitlementEvents, enqueueOutboxEvent } from './integrationOutbox';

async function createTestProduct(name: string) {
  return prisma.product.create({
    data: {
      name,
      slug: `outbox-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      category: 'テスト',
      itemType: 'nft',
      basePrice: 10000,
      status: 'published',
    },
  });
}

async function createTestOrder(productId: string, opts: { quantity?: number } = {}) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `SG-OUTBOX-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      totalAmount: 10000,
      originalAmount: 10000,
      paymentStatus: 'paid',
      orderStatus: 'paid',
      customerName: 'Outboxテスト太郎',
      customerEmail: 'outbox-test@example.com',
      termsAgreedAt: new Date(),
      termsVersion: '2026-07-01',
      commonUserId: 'cu_test_00000001',
      registrationReferrerAgentCode: 'AGT-REF-001',
      assignedAgentCode: 'AGT-ASN-001',
      salesAgentCode: 'AGT-SALES-001',
      closingAgentCode: 'AGT-CLOSE-001',
      referralSessionKey: 'rsk_test_001',
    },
  });
  const orderItem = await prisma.orderItem.create({
    data: {
      orderId: order.id,
      productId,
      productName: 'Outboxテスト商品',
      itemType: 'nft',
      quantity: opts.quantity ?? 1,
      unitPrice: 10000,
      subtotal: 10000,
    },
  });
  return { order, orderItem };
}

describe('integrationOutbox: enqueueOutboxEvent', () => {
  afterAll(async () => {
    await prisma.integrationOutboxEvent.deleteMany({ where: { correlationId: { startsWith: 'outbox-unit-test-' } } });
    await prisma.$disconnect();
  });

  it('evt_プレフィックスのeventId・payloadHash・既定status=pendingで作成する', async () => {
    const correlationId = `outbox-unit-test-${Date.now()}`;
    const payload = { foo: 'bar', n: 1 };

    await prisma.$transaction(async (tx) => {
      await enqueueOutboxEvent(tx, {
        eventType: 'order.paid',
        destinationSystemKey: 'ove-wallet',
        payload,
        correlationId,
      });
    });

    const row = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId } });
    expect(row.eventId.startsWith('evt_')).toBe(true);
    expect(row.status).toBe('pending');
    expect(row.attemptCount).toBe(0);
    expect(row.destinationSystemKey).toBe('ove-wallet');
    expect(row.payloadHash).toBe(crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
  });
});

describe('integrationOutbox: enqueueEntitlementEvents', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('商品にProductIntegrationRuleが未設定なら何もエンキューしない(既存商品はすべてこの状態)', async () => {
    const product = await createTestProduct('no-rule');
    const { order, orderItem } = await createTestOrder(product.id);

    await prisma.$transaction(async (tx) => {
      await enqueueEntitlementEvents(tx, order, [orderItem], 'entitlement.granted');
    });

    const rows = await prisma.integrationOutboxEvent.findMany({ where: { correlationId: order.id } });
    expect(rows).toHaveLength(0);

    await prisma.orderItem.delete({ where: { id: orderItem.id } });
    await prisma.order.delete({ where: { id: order.id } });
    await prisma.product.delete({ where: { id: product.id } });
  });

  it('ProductIntegrationRuleが設定されている商品はentitlement.grantedを正しい形でエンキューする', async () => {
    const product = await createTestProduct('with-rule-grant');
    await prisma.productIntegrationRule.create({
      data: {
        productId: product.id,
        productCode: 'PASSPORT-GOLD',
        entitlementTargetSystemKey: 'sengoku-passport',
        entitlementType: 'castle_lord_contract',
        revokeOnRefund: true,
      },
    });
    const { order, orderItem } = await createTestOrder(product.id, { quantity: 3 });

    await prisma.$transaction(async (tx) => {
      await enqueueEntitlementEvents(tx, order, [orderItem], 'entitlement.granted');
    });

    const rows = await prisma.integrationOutboxEvent.findMany({ where: { correlationId: order.id } });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.eventType).toBe('entitlement.granted');
    expect(row.destinationSystemKey).toBe('sengoku-passport');
    expect(row.status).toBe('pending');
    const payload = row.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      source_system_key: 'sengoku-market',
      common_user_id: 'cu_test_00000001',
      registration_referrer_agency_id: 'AGT-REF-001',
      assigned_agency_id: 'AGT-ASN-001',
      sales_agent_id: 'AGT-SALES-001',
      closing_agent_id: 'AGT-CLOSE-001',
      referral_session_key: 'rsk_test_001',
      order_id: order.id,
      order_item_id: orderItem.id,
      product_code: 'PASSPORT-GOLD',
      entitlement_type: 'castle_lord_contract',
      quantity: 3,
    });

    await prisma.integrationOutboxEvent.deleteMany({ where: { correlationId: order.id } });
    await prisma.orderItem.delete({ where: { id: orderItem.id } });
    await prisma.order.delete({ where: { id: order.id } });
    await prisma.productIntegrationRule.delete({ where: { productId: product.id } });
    await prisma.product.delete({ where: { id: product.id } });
  });

  it('revokeOnRefund=falseの商品はentitlement.revokedをエンキューしない(grantedはする)', async () => {
    const product = await createTestProduct('no-revoke');
    await prisma.productIntegrationRule.create({
      data: {
        productId: product.id,
        entitlementTargetSystemKey: 'ove-wallet',
        entitlementType: 'reward_point',
        revokeOnRefund: false,
      },
    });
    const { order, orderItem } = await createTestOrder(product.id);

    await prisma.$transaction(async (tx) => {
      await enqueueEntitlementEvents(tx, order, [orderItem], 'entitlement.granted');
      await enqueueEntitlementEvents(tx, order, [orderItem], 'entitlement.revoked');
    });

    const rows = await prisma.integrationOutboxEvent.findMany({
      where: { correlationId: order.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('entitlement.granted');

    await prisma.integrationOutboxEvent.deleteMany({ where: { correlationId: order.id } });
    await prisma.orderItem.delete({ where: { id: orderItem.id } });
    await prisma.order.delete({ where: { id: order.id } });
    await prisma.productIntegrationRule.delete({ where: { productId: product.id } });
    await prisma.product.delete({ where: { id: product.id } });
  });
});
