import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();

describe('管理API: 代理店・紹介成果管理', () => {
  let agencyId: string;
  let orderId: string;
  let commissionId: string;

  beforeAll(async () => {
    const agency = await prisma.agency.create({
      data: { name: `admin-referrals-test代理店-${Date.now()}`, code: `RATAG-${Date.now()}`, defaultCommissionRate: 10 },
    });
    agencyId = agency.id;

    const order = await prisma.order.create({
      data: {
        orderNumber: `SG-REFADMIN-${Date.now()}`,
        totalAmount: 20000,
        originalAmount: 20000,
        paymentStatus: 'paid',
        orderStatus: 'paid',
        paidAt: new Date('2026-06-15T00:00:00Z'),
        customerName: 'テスト',
        customerEmail: 'admin-referrals-test@example.com',
        agencyId,
        referralCode: 'SGI-TEST',
        commissionRate: 10,
        commissionAmount: 2000,
        commissionStatus: 'pending',
        termsAgreedAt: new Date(),
        termsVersion: '2026-07-01',
      },
    });
    orderId = order.id;

    const commission = await prisma.commission.create({
      data: {
        orderId: order.id,
        agencyId,
        referralCode: 'SGI-TEST',
        baseAmount: 20000,
        commissionRate: 10,
        commissionAmount: 2000,
        status: 'pending',
      },
    });
    commissionId = commission.id;
  });

  afterAll(async () => {
    await prisma.commission.deleteMany({ where: { agencyId } });
    await prisma.order.deleteMany({ where: { id: orderId } });
    await prisma.agency.deleteMany({ where: { id: agencyId } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  it('報酬ステータスを更新するとordersのキャッシュも同期される', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .put(`/api/admin/referrals/commissions/${commissionId}`)
      .set('Origin', TEST_ORIGIN)
      .send({ status: 'approved' });

    expect(res.status).toBe(200);
    expect(res.body.commission.status).toBe('approved');
    expect(res.body.commission.approvedAt).not.toBeNull();

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.commissionStatus).toBe('approved');
  });

  describe('不正な状態遷移の拒否(仕様書外の拡張・保守性改善Phase6)', () => {
    it('pending→paidは409を返す(approvedを必ず経由させる)', async () => {
      const order = await prisma.order.create({
        data: {
          orderNumber: `SG-REFADMIN-TRANSITION-${Date.now()}`,
          totalAmount: 20000,
          originalAmount: 20000,
          paymentStatus: 'paid',
          orderStatus: 'paid',
          customerName: 'テスト',
          customerEmail: `admin-referrals-test-transition-${Date.now()}@example.com`,
          agencyId,
          referralCode: 'SGI-TEST',
          commissionRate: 10,
          commissionAmount: 2000,
          commissionStatus: 'pending',
          termsAgreedAt: new Date(),
          termsVersion: '2026-07-01',
        },
      });
      const commission = await prisma.commission.create({
        data: { orderId: order.id, agencyId, referralCode: 'SGI-TEST', baseAmount: 20000, commissionRate: 10, commissionAmount: 2000, status: 'pending' },
      });

      const { agent } = await createAdminAgent(app);
      const res = await agent
        .put(`/api/admin/referrals/commissions/${commission.id}`)
        .set('Origin', TEST_ORIGIN)
        .send({ status: 'paid' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_COMMISSION_STATUS_TRANSITION');

      const persisted = await prisma.commission.findUniqueOrThrow({ where: { id: commission.id } });
      expect(persisted.status).toBe('pending');

      await prisma.commission.delete({ where: { id: commission.id } });
      await prisma.order.delete({ where: { id: order.id } });
    });
  });

  it('CSV出力: 期間内・approved対象で1行出力される', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .get('/api/admin/referrals/export.csv')
      .query({ from: '2026-06-01', to: '2026-06-30', status: 'pending,approved' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const text = res.text;
    expect(text).toContain('SG-REFADMIN');
    expect(text).toContain('2000');
  });

  it('CSV出力: 期間外は含まれない', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .get('/api/admin/referrals/export.csv')
      .query({ from: '2026-01-01', to: '2026-01-31', status: 'pending,approved' });

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('SG-REFADMIN');
  });

  it('CSV出力: mark_approved=trueでpendingがapprovedに一括変更される', async () => {
    await prisma.commission.update({ where: { id: commissionId }, data: { status: 'pending', approvedAt: null } });
    await prisma.order.update({ where: { id: orderId }, data: { commissionStatus: 'pending' } });

    const { agent } = await createAdminAgent(app);
    const res = await agent
      .get('/api/admin/referrals/export.csv')
      .query({ from: '2026-06-01', to: '2026-06-30', status: 'pending', mark_approved: 'true' });

    expect(res.status).toBe(200);

    const commission = await prisma.commission.findUniqueOrThrow({ where: { id: commissionId } });
    expect(commission.status).toBe('approved');

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.commissionStatus).toBe('approved');
  });

  it('CSV出力: cancelledをstatus指定しても含まれない', async () => {
    await prisma.commission.update({ where: { id: commissionId }, data: { status: 'cancelled' } });

    const { agent } = await createAdminAgent(app);
    const res = await agent
      .get('/api/admin/referrals/export.csv')
      .query({ from: '2026-06-01', to: '2026-06-30', status: 'pending,approved,cancelled' });

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('SG-REFADMIN');
  });
});

describe('報酬一覧のページネーション(仕様書外の拡張・保守性改善Phase8)', () => {
  const codeMarker = `PAGETEST-${Date.now()}`;
  const TOTAL_COMMISSIONS = 55;

  beforeAll(async () => {
    const agency = await prisma.agency.create({
      data: { name: `commission-pagetest代理店-${Date.now()}`, code: `CPGTEST-${Date.now()}` },
    });
    for (let i = 0; i < TOTAL_COMMISSIONS; i++) {
      const order = await prisma.order.create({
        data: {
          orderNumber: `SG-CPGTEST-${i}-${Date.now()}`,
          totalAmount: 1000,
          originalAmount: 1000,
          paymentStatus: 'paid',
          orderStatus: 'paid',
          customerName: 'ページテスト',
          customerEmail: `commission-pagetest-${i}-${Date.now()}@example.com`,
          agencyId: agency.id,
          referralCode: codeMarker,
          termsAgreedAt: new Date(),
          termsVersion: '2026-07-01',
        },
      });
      await prisma.commission.create({
        data: { orderId: order.id, agencyId: agency.id, referralCode: codeMarker, baseAmount: 1000, commissionRate: 10, commissionAmount: 100, status: 'pending' },
      });
    }
  });

  afterAll(async () => {
    await prisma.commission.deleteMany({ where: { referralCode: codeMarker } });
    await prisma.order.deleteMany({ where: { referralCode: codeMarker } });
    await prisma.$disconnect();
  });

  it('既定のpageSize(50)で1ページ目にはpageSize件、totalには全件数が入る', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/referrals/commissions').set('Origin', TEST_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body.commissions.length).toBe(50);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(50);
    expect(res.body.total).toBeGreaterThanOrEqual(TOTAL_COMMISSIONS);
  });

  it('page=2を指定すると2ページ目の残り件数が返る', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/referrals/commissions').query({ page: 2 }).set('Origin', TEST_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.commissions.length).toBeGreaterThan(0);
  });
});
