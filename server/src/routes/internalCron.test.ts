import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { createPendingOrder } from '../services/checkout';

const syncAgencyHierarchyFromExternalSystem = vi.fn(async () => ({ agenciesSynced: 2, applicationsApproved: 0 }));

vi.mock('../services/agencyHierarchySync', () => ({
  syncAgencyHierarchyFromExternalSystem: () => syncAgencyHierarchyFromExternalSystem(),
}));

const app = createApp();

describe('内部cron: 外部代理店システム階層同期(仕様書外の拡張)', () => {
  const originalSecret = process.env.CRON_SECRET;

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it('CRON_SECRET未設定の場合は503', async () => {
    delete process.env.CRON_SECRET;
    const res = await request(app).get('/api/internal/cron/sync-agency-hierarchy');
    expect(res.status).toBe(503);
  });

  it('Authorizationヘッダーが一致しない場合は401', async () => {
    process.env.CRON_SECRET = 'test-cron-secret';
    const res = await request(app)
      .get('/api/internal/cron/sync-agency-hierarchy')
      .set('Authorization', 'Bearer wrong-secret');
    expect(res.status).toBe(401);
  });

  it('正しいCRON_SECRETで同期が実行される', async () => {
    process.env.CRON_SECRET = 'test-cron-secret';
    const res = await request(app)
      .get('/api/internal/cron/sync-agency-hierarchy')
      .set('Authorization', 'Bearer test-cron-secret');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ agenciesSynced: 2, applicationsApproved: 0 });
  });
});

describe('内部cron: 銀行振込注文の失効(仕様書外の拡張)', () => {
  let productId: string;
  let variantId: string;
  const originalSecret = process.env.CRON_SECRET;

  beforeAll(async () => {
    const product = await prisma.product.create({
      data: {
        name: '振込期限テスト商品',
        slug: `cron-banktransfer-test-${Date.now()}`,
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
    await prisma.order.deleteMany({ where: { customerEmail: { contains: 'cron-banktransfer-test' } } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.$disconnect();
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  async function createBankTransferOrder(email: string) {
    const { order } = await createPendingOrder({
      customerName: '振込テスト太郎',
      customerEmail: email,
      customerPhone: '090-0000-0000',
      customerPostalCode: '100-0001',
      customerAddress: '東京都千代田区1-1-1',
      agreedToTerms: true,
      items: [{ variantId, quantity: 1 }],
      paymentMethod: 'bank_transfer',
    });
    return order;
  }

  it('振込期限(7日)を過ぎたpendingの銀行振込注文は失効し在庫が解放される。期限内の注文はそのまま', async () => {
    process.env.CRON_SECRET = 'test-cron-secret-banktransfer';

    const overdueOrder = await createBankTransferOrder(`cron-banktransfer-test-overdue-${Date.now()}@example.com`);
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await prisma.order.update({ where: { id: overdueOrder.id }, data: { createdAt: eightDaysAgo } });

    const withinWindowOrder = await createBankTransferOrder(`cron-banktransfer-test-recent-${Date.now()}@example.com`);

    const res = await request(app)
      .get('/api/internal/cron/expire-bank-transfer-orders')
      .set('Authorization', 'Bearer test-cron-secret-banktransfer');
    expect(res.status).toBe(200);
    expect(res.body.expiredCount).toBeGreaterThanOrEqual(1);

    const updatedOverdue = await prisma.order.findUniqueOrThrow({ where: { id: overdueOrder.id } });
    expect(updatedOverdue.paymentStatus).toBe('expired');
    expect(updatedOverdue.expiredAt).not.toBeNull();

    const updatedRecent = await prisma.order.findUniqueOrThrow({ where: { id: withinWindowOrder.id } });
    expect(updatedRecent.paymentStatus).toBe('pending');

    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
    // 期限切れ注文の分だけ解放され、期限内の注文の仮引当(1)は残る
    expect(variant.reservedStock).toBe(1);
  });
});
