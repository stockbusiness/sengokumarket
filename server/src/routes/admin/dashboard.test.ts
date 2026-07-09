import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent } from '../../test/adminAgent';

const app = createApp();

describe('管理API: ダッシュボード月別売上推移(仕様書外の拡張)', () => {
  const orderIds: string[] = [];

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  async function createPaidOrder(paidAt: Date, totalAmount: number) {
    const order = await prisma.order.create({
      data: {
        orderNumber: `SG-TREND-${Math.random().toString(36).slice(2)}`,
        totalAmount,
        originalAmount: totalAmount,
        paymentStatus: 'paid',
        orderStatus: 'paid',
        paidAt,
        customerName: 'テスト',
        customerEmail: `dashboard-trend-test-${Math.random().toString(36).slice(2)}@example.com`,
        termsAgreedAt: paidAt,
        termsVersion: '2026-07-01',
      },
    });
    orderIds.push(order.id);
    return order;
  }

  it('直近3ヶ月分を月別に集計し、売上のない月は0で埋める', async () => {
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 15);
    const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 10);

    await createPaidOrder(thisMonth, 10000);
    await createPaidOrder(thisMonth, 5000);
    await createPaidOrder(twoMonthsAgo, 30000);

    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/dashboard/sales-trend?months=3');

    expect(res.status).toBe(200);
    expect(res.body.trend).toHaveLength(3);

    const key = (d: Date) => d.toISOString().slice(0, 7);
    const byMonth = new Map(res.body.trend.map((t: { month: string }) => [t.month, t]));

    expect(byMonth.get(key(twoMonthsAgo))).toEqual({ month: key(twoMonthsAgo), totalSales: 30000, orderCount: 1 });
    expect(byMonth.get(key(thisMonth))).toEqual({ month: key(thisMonth), totalSales: 15000, orderCount: 2 });

    const middleMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    expect(byMonth.get(key(middleMonth))).toEqual({ month: key(middleMonth), totalSales: 0, orderCount: 0 });
  });

  it('monthsは最大12にクランプされる', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/dashboard/sales-trend?months=99');
    expect(res.status).toBe(200);
    expect(res.body.trend).toHaveLength(12);
  });
});
