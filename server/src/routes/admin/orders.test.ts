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
        originalAmount: 10000,
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

  describe('銀行振込の入金確認(仕様書外の拡張)', () => {
    it('銀行振込のpending注文を入金確認すると決済完了と同じ処理(在庫確定・報酬計算)が走る', async () => {
      const product = await prisma.product.create({
        data: {
          name: '入金確認テスト商品',
          slug: `admin-orders-test-banktransfer-${Date.now()}`,
          category: 'テスト',
          itemType: 'nft',
          basePrice: 10000,
          status: 'published',
        },
      });
      const variant = await prisma.productVariant.create({
        data: { productId: product.id, name: 'A', price: 10000, stock: 5, reservedStock: 1 },
      });
      const order = await prisma.order.create({
        data: {
          orderNumber: `SG-BANKTRANSFERTEST-${Date.now()}`,
          totalAmount: 10000,
          originalAmount: 10000,
          paymentStatus: 'pending',
          orderStatus: 'pending',
          paymentMethod: 'bank_transfer',
          customerName: '入金確認太郎',
          customerEmail: `admin-orders-test-banktransfer-${Date.now()}@example.com`,
          termsAgreedAt: new Date(),
          termsVersion: '2026-07-01',
        },
      });
      await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          variantId: variant.id,
          productName: product.name,
          itemType: 'nft',
          quantity: 1,
          unitPrice: 10000,
          subtotal: 10000,
        },
      });

      const { agent } = await createAdminAgent(app);
      const res = await agent.post(`/api/admin/orders/${order.id}/confirm-bank-transfer`).set('Origin', TEST_ORIGIN).send();

      expect(res.status).toBe(200);
      expect(res.body.order.paymentStatus).toBe('paid');
      expect(res.body.order.orderStatus).toBe('paid');

      const updatedVariant = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
      expect(updatedVariant.stock).toBe(4);
      expect(updatedVariant.reservedStock).toBe(0);

      const nftIssueCount = await prisma.nftIssue.count({ where: { orderId: order.id } });
      expect(nftIssueCount).toBe(1);

      await prisma.nftIssue.deleteMany({ where: { orderId: order.id } });
      await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
      await prisma.order.delete({ where: { id: order.id } });
      await prisma.productVariant.delete({ where: { id: variant.id } });
      await prisma.product.delete({ where: { id: product.id } });
    });

    it('既にpaid済みの銀行振込注文を再度入金確認すると400を返す(二重処理防止)', async () => {
      const order = await prisma.order.create({
        data: {
          orderNumber: `SG-BANKTRANSFERTEST-PAID-${Date.now()}`,
          totalAmount: 10000,
          originalAmount: 10000,
          paymentStatus: 'paid',
          orderStatus: 'paid',
          paymentMethod: 'bank_transfer',
          customerName: 'テスト',
          customerEmail: `admin-orders-test-banktransfer-paid-${Date.now()}@example.com`,
          termsAgreedAt: new Date(),
          termsVersion: '2026-07-01',
        },
      });

      const { agent } = await createAdminAgent(app);
      const res = await agent.post(`/api/admin/orders/${order.id}/confirm-bank-transfer`).set('Origin', TEST_ORIGIN).send();

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ALREADY_PAID');

      await prisma.order.delete({ where: { id: order.id } });
    });

    it('Stripe決済の注文を入金確認しようとすると400を返す', async () => {
      const order = await prisma.order.create({
        data: {
          orderNumber: `SG-BANKTRANSFERTEST-STRIPE-${Date.now()}`,
          totalAmount: 10000,
          originalAmount: 10000,
          paymentStatus: 'pending',
          orderStatus: 'pending',
          paymentMethod: 'stripe',
          customerName: 'テスト',
          customerEmail: `admin-orders-test-banktransfer-stripe-${Date.now()}@example.com`,
          termsAgreedAt: new Date(),
          termsVersion: '2026-07-01',
        },
      });

      const { agent } = await createAdminAgent(app);
      const res = await agent.post(`/api/admin/orders/${order.id}/confirm-bank-transfer`).set('Origin', TEST_ORIGIN).send();

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('NOT_BANK_TRANSFER_ORDER');

      await prisma.order.delete({ where: { id: order.id } });
    });
  });
});
