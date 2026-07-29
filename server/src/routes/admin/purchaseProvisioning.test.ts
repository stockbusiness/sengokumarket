import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';
import { enqueueProvisioningJobIfEligible } from '../../services/purchaseProvisioningJobs';

const app = createApp();

async function createAgencyProduct(suffix: string) {
  return prisma.product.create({
    data: {
      name: '管理APIテスト代理店プラン',
      slug: `admin-ppj-test-${suffix}-${Date.now()}`,
      category: 'テスト',
      itemType: 'membership',
      basePrice: 30000,
      agencyAccessMode: 'agent_portal',
      agencyRole: 'participant',
      agencyProductCode: 'agency_entry_plan',
    },
  });
}

async function createOrderWithJob(productId: string, suffix: string) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `SG-ADMINPPJTEST-${suffix}-${Date.now()}`,
      totalAmount: 30000,
      originalAmount: 30000,
      paymentStatus: 'paid',
      orderStatus: 'paid',
      customerName: '管理APIテスト太郎',
      customerEmail: `admin-ppj-test-${suffix}@example.com`,
      termsAgreedAt: new Date(),
      termsVersion: '2026-07-01',
      orderItems: {
        create: { productId, productName: 'テスト', itemType: 'membership', quantity: 1, unitPrice: 30000, subtotal: 30000 },
      },
    },
  });
  const orderItems = await prisma.orderItem.findMany({ where: { orderId: order.id } });
  await prisma.$transaction((tx) => enqueueProvisioningJobIfEligible(tx, order, orderItems));
  const job = await prisma.purchaseProvisioningJob.findUniqueOrThrow({
    where: { deduplicationKey: `purchase-provisioning:${order.id}` },
  });
  return { order, job };
}

// 購入後代理店システム連携実装指示書 6.13章「管理画面」。
describe('管理API: purchase-provisioning-jobs一覧', () => {
  const createdOrderIds: string[] = [];
  const createdProductIds: string[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await prisma.purchaseProvisioningJob.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    await prisma.$disconnect();
  });

  it('管理者は一覧を取得でき、statusで絞り込める', async () => {
    const { agent } = await createAdminAgent(app);
    const product = await createAgencyProduct('list');
    createdProductIds.push(product.id);
    const { order, job } = await createOrderWithJob(product.id, 'list');
    createdOrderIds.push(order.id);

    const res = await agent.get('/api/admin/purchase-provisioning-jobs').set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.jobs.some((j: { id: string }) => j.id === job.id)).toBe(true);

    const filtered = await agent.get('/api/admin/purchase-provisioning-jobs?status=pending').set('Origin', TEST_ORIGIN);
    expect(filtered.status).toBe(200);
    expect(filtered.body.jobs.every((j: { status: string }) => j.status === 'pending')).toBe(true);

    const succeededOnly = await agent.get('/api/admin/purchase-provisioning-jobs?status=succeeded').set('Origin', TEST_ORIGIN);
    expect(succeededOnly.body.jobs.some((j: { id: string }) => j.id === job.id)).toBe(false);
  });

  it('注文番号で検索できる', async () => {
    const { agent } = await createAdminAgent(app);
    const product = await createAgencyProduct('search');
    createdProductIds.push(product.id);
    const { order, job } = await createOrderWithJob(product.id, 'search');
    createdOrderIds.push(order.id);

    const res = await agent
      .get(`/api/admin/purchase-provisioning-jobs?search=${encodeURIComponent(order.orderNumber)}`)
      .set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.jobs.some((j: { id: string }) => j.id === job.id)).toBe(true);
  });

  it('不正なstatusは400を返す', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/purchase-provisioning-jobs?status=not-a-real-status').set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('pending状態のジョブをskipできる', async () => {
    const { agent } = await createAdminAgent(app);
    const product = await createAgencyProduct('skip');
    createdProductIds.push(product.id);
    const { order, job } = await createOrderWithJob(product.id, 'skip');
    createdOrderIds.push(order.id);

    const res = await agent.post(`/api/admin/purchase-provisioning-jobs/${job.id}/skip`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const updated = await prisma.purchaseProvisioningJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe('skipped');
  });

  it('存在しないジョブのretryは404を返す', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .post('/api/admin/purchase-provisioning-jobs/00000000-0000-0000-0000-000000000000/retry')
      .set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('backlog件数を取得できる', async () => {
    const { agent } = await createAdminAgent(app);
    const product = await createAgencyProduct('backlog');
    createdProductIds.push(product.id);
    const { order } = await createOrderWithJob(product.id, 'backlog');
    createdOrderIds.push(order.id);

    const res = await agent.get('/api/admin/purchase-provisioning-jobs/backlog').set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.total).toBe(res.body.pending + res.body.blocked);
  });
});
