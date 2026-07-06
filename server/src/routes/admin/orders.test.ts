import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();

describe('管理API: 注文管理', () => {
  let orderId: string;
  let originalReferralCode: string | null;

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { customerEmail: { contains: 'admin-orders-test' } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  it('注文ステータスとメモを更新できるが、紹介コードは変更できない', async () => {
    const { agent } = await createAdminAgent(app);

    const order = await prisma.order.create({
      data: {
        orderNumber: `SG-ADMINTEST-${Date.now()}`,
        totalAmount: 10000,
        paymentStatus: 'paid',
        orderStatus: 'paid',
        customerName: 'テスト',
        customerEmail: 'admin-orders-test@example.com',
        referralCode: 'SGI001',
        termsAgreedAt: new Date(),
        termsVersion: '2026-07-01',
      },
    });
    orderId = order.id;
    originalReferralCode = order.referralCode;

    const res = await agent
      .put(`/api/admin/orders/${orderId}`)
      .set('Origin', TEST_ORIGIN)
      .send({ orderStatus: 'cancelled', adminNote: '返品対応済み', referralCode: 'HACKED' });

    expect(res.status).toBe(200);
    expect(res.body.order.orderStatus).toBe('cancelled');
    expect(res.body.order.adminNote).toBe('返品対応済み');

    const persisted = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(persisted.referralCode).toBe(originalReferralCode);
  });

  it('不正な注文ステータスは400を返す', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.put(`/api/admin/orders/${orderId}`).set('Origin', TEST_ORIGIN).send({ orderStatus: 'invalid' });
    expect(res.status).toBe(400);
  });
});
