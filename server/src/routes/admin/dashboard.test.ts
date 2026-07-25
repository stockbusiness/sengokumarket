import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent } from '../../test/adminAgent';
import { enqueueNotification } from '../../modules/notifications/infrastructure/notificationOutbox.repository';
import { enqueueCommonUserResolveJob } from '../../services/orderLinkingJobs';
import { enqueueOutboxEvent } from '../../services/integrationOutbox';

const app = createApp();

// 本番安定化指示書Stage11(14.3「アラート」): ダッシュボードのdead/blocked件数。
describe('管理API: ダッシュボードアラート件数(本番安定化指示書Stage11)', () => {
  const userIds: string[] = [];
  const notificationRecipients: string[] = [];
  const outboxCorrelationId = `dashboard-alerts-test-${Date.now()}`;

  afterAll(async () => {
    await prisma.notificationOutboxEvent.deleteMany({ where: { recipient: { in: notificationRecipients } } });
    await prisma.orderLinkingJob.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.integrationOutboxEvent.deleteMany({ where: { correlationId: outboxCorrelationId } });
    await prisma.$disconnect();
  });

  it('dead/blocked状態の各件数がalertsへ反映される', async () => {
    const recipient = `dashboard-alerts-notif-test-${Date.now()}@example.com`;
    notificationRecipients.push(recipient);
    await prisma.$transaction((tx) => enqueueNotification(tx, { eventType: 'agency_access_granted', recipient, payload: { name: 'テスト代理店' } }));
    const notif = await prisma.notificationOutboxEvent.findFirstOrThrow({ where: { recipient } });
    await prisma.notificationOutboxEvent.update({ where: { id: notif.id }, data: { status: 'dead' } });

    const user = await prisma.user.create({
      data: {
        name: 'ダッシュボードアラートテスト',
        email: `dashboard-alerts-user-test-${Date.now()}@example.com`,
        passwordHash: 'x',
      },
    });
    userIds.push(user.id);
    const linkingJob = await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));
    await prisma.orderLinkingJob.update({ where: { id: linkingJob.id }, data: { status: 'dead' } });

    const conflictUser = await prisma.user.create({
      data: {
        name: 'ダッシュボードアラート競合テスト',
        email: `dashboard-alerts-conflict-test-${Date.now()}@example.com`,
        passwordHash: 'x',
      },
    });
    userIds.push(conflictUser.id);
    const conflictJob = await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: conflictUser.id }));
    await prisma.orderLinkingJob.update({
      where: { id: conflictJob.id },
      data: { status: 'blocked', blockedReason: 'common_user_id_conflict' },
    });

    await prisma.$transaction(async (tx) => {
      await enqueueOutboxEvent(tx, {
        eventType: 'entitlement.granted',
        destinationSystemKey: 'sengoku-passport',
        payload: {},
        correlationId: outboxCorrelationId,
      });
    });
    const outboxEvent = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId: outboxCorrelationId } });
    await prisma.integrationOutboxEvent.update({ where: { id: outboxEvent.id }, data: { status: 'dead' } });

    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.alerts.deadNotificationCount).toBeGreaterThanOrEqual(1);
    expect(res.body.alerts.deadLinkingJobCount).toBeGreaterThanOrEqual(1);
    expect(res.body.alerts.deadIntegrationEventCount).toBeGreaterThanOrEqual(1);
    expect(res.body.alerts.commonIdConflictCount).toBeGreaterThanOrEqual(1);
    expect(res.body.alerts.migrationReadinessError).toBe(false);
  });
});

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
