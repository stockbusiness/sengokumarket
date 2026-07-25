import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();

async function createViewerAgent() {
  const email = `order-wallet-tx-viewer-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await prisma.user.create({
    data: { name: '閲覧専用管理者', email, passwordHash: await bcrypt.hash('viewerpassword1', 10), role: 'admin_viewer' },
  });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'viewerpassword1' });
  return agent;
}

const namePrefix = 'order-wallet-tx-route-test';

async function createFixture(suffix: string) {
  const product = await prisma.product.create({
    data: { name: `${namePrefix}-${suffix}`, slug: `${namePrefix}-${suffix}`, category: 'テスト', itemType: 'nft', basePrice: 1000, status: 'published' },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `SG-WALLETTXTEST-${suffix}`,
      totalAmount: 1000,
      originalAmount: 1000,
      customerName: 'ウォレット取引テスト太郎',
      customerEmail: `${namePrefix}-${suffix}@example.com`,
      termsAgreedAt: new Date(),
      termsVersion: '2026-07-01',
      commonUserId: `cu_${suffix}`,
    },
  });
  const orderItem = await prisma.orderItem.create({
    data: { orderId: order.id, productId: product.id, productName: product.name, itemType: 'nft', quantity: 1, unitPrice: 1000, subtotal: 1000 },
  });
  const outboxEvent = await prisma.integrationOutboxEvent.create({
    data: {
      eventId: `evt_${suffix}`,
      eventType: 'entitlement.granted',
      destinationSystemKey: 'ove-wallet',
      originalPayload: {},
      originalPayloadHash: 'x',
      deliveryPayload: {},
      deliveryPayloadHash: 'x',
      status: 'succeeded',
    },
  });
  const walletTransaction = await prisma.orderWalletTransaction.create({
    data: {
      orderId: order.id,
      orderItemId: orderItem.id,
      outboxEventId: outboxEvent.id,
      commonUserId: order.commonUserId,
      transactionType: 'grant',
      amount: 100,
      walletTransactionId: `tx_${suffix}`,
      idempotencyKey: `evt_${suffix}`,
      status: 'succeeded',
    },
  });
  return { product, order, orderItem, outboxEvent, walletTransaction };
}

// 本番安定化指示書Stage10(13.5「管理画面で確認可能」): order_wallet_transactions一覧APIの検証。
describe('管理API: order-wallet-transactions一覧(本番安定化指示書Stage10)', () => {
  afterAll(async () => {
    await prisma.orderWalletTransaction.deleteMany({ where: { walletTransactionId: { startsWith: 'tx_' } } });
    await prisma.integrationOutboxEvent.deleteMany({ where: { eventId: { startsWith: 'evt_' } } });
    await prisma.orderItem.deleteMany({ where: { product: { name: { startsWith: namePrefix } } } });
    await prisma.order.deleteMany({ where: { orderNumber: { startsWith: 'SG-WALLETTXTEST-' } } });
    await prisma.product.deleteMany({ where: { name: { startsWith: namePrefix } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'order-wallet-tx-viewer-test' } } });
    await prisma.$disconnect();
  });

  it('未認証は401になる', async () => {
    const res = await request(app).get('/api/admin/order-wallet-transactions');
    expect(res.status).toBe(401);
  });

  it('管理者は一覧を取得でき、orderIdで絞り込める', async () => {
    const { agent } = await createAdminAgent(app);
    const { order, walletTransaction } = await createFixture(`list-${Date.now()}`);

    const res = await agent.get('/api/admin/order-wallet-transactions');
    expect(res.status).toBe(200);
    expect(res.body.transactions.some((t: { id: string }) => t.id === walletTransaction.id)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(res.body.page).toBe(1);

    const filtered = await agent.get(`/api/admin/order-wallet-transactions?orderId=${order.id}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.transactions).toHaveLength(1);
    expect(filtered.body.transactions[0].id).toBe(walletTransaction.id);

    const noMatch = await agent.get('/api/admin/order-wallet-transactions?orderId=00000000-0000-0000-0000-000000000000');
    expect(noMatch.status).toBe(200);
    expect(noMatch.body.transactions).toHaveLength(0);
  });

  it('commonUserIdで絞り込める', async () => {
    const { agent } = await createAdminAgent(app);
    const suffix = `commonuser-${Date.now()}`;
    const { walletTransaction } = await createFixture(suffix);

    const res = await agent.get(`/api/admin/order-wallet-transactions?commonUserId=cu_${suffix}`);
    expect(res.status).toBe(200);
    expect(res.body.transactions.map((t: { id: string }) => t.id)).toContain(walletTransaction.id);
  });

  it('閲覧専用管理者も一覧を閲覧できる', async () => {
    const agent = await createViewerAgent();
    const res = await agent.get('/api/admin/order-wallet-transactions');
    expect(res.status).toBe(200);
  });
});
