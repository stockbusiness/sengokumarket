import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  describe('不正な状態遷移の拒否(仕様書外の拡張・保守性改善Phase6)', () => {
    it('refunded→paidは409を返し、DBの状態も変化しない', async () => {
      const order = await prisma.order.create({
        data: {
          orderNumber: `SG-ADMINTEST-TRANSITION-${Date.now()}`,
          totalAmount: 10000,
          originalAmount: 10000,
          paymentStatus: 'refunded',
          orderStatus: 'refunded',
          customerName: 'テスト',
          customerEmail: `admin-orders-test-transition-${Date.now()}@example.com`,
          termsAgreedAt: new Date(),
          termsVersion: '2026-07-01',
        },
      });

      const { agent } = await createAdminAgent(app);
      const res = await agent.put(`/api/admin/orders/${order.id}`).set('Origin', TEST_ORIGIN).send({ orderStatus: 'paid' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_ORDER_STATUS_TRANSITION');

      const persisted = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(persisted.orderStatus).toBe('refunded');

      await prisma.order.delete({ where: { id: order.id } });
    });
  });

  describe('説明責任者の後入力・修正(仕様書外の拡張)', () => {
    it('説明責任者名を後から入力でき、紹介コード等の報酬関連フィールドは変更されない', async () => {
      const { agent } = await createAdminAgent(app);

      const res = await agent
        .put(`/api/admin/orders/${orderId}`)
        .set('Origin', TEST_ORIGIN)
        .send({ explainerName: `管理画面から入力した説明担当者-${Date.now()}` });

      expect(res.status).toBe(200);
      expect(res.body.order.explainerName).toContain('管理画面から入力した説明担当者');

      const persisted = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(persisted.referralCode).toBe(originalReferralCode);
      expect(persisted.agencyId).toBeNull();
      expect(persisted.influencerId).toBeNull();
      expect(Number(persisted.commissionRate)).toBe(0);
    });

    it('名簿と一致する説明責任者名を入力すると一致結果が反映され、一致しない名前に更新すると外れる', async () => {
      const agency = await prisma.agency.create({ data: { name: `管理画面照合テスト代理店-${Date.now()}`, code: `ADMINEXPMATCH-${Date.now()}` } });
      const { agent } = await createAdminAgent(app);

      const matched = await agent.put(`/api/admin/orders/${orderId}`).set('Origin', TEST_ORIGIN).send({ explainerName: agency.name });
      expect(matched.status).toBe(200);
      expect(matched.body.order.explainerMatched).toBe(true);

      const persistedMatched = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(persistedMatched.explainerAgencyId).toBe(agency.id);

      const unmatched = await agent
        .put(`/api/admin/orders/${orderId}`)
        .set('Origin', TEST_ORIGIN)
        .send({ explainerName: `一致しない名前-${Date.now()}` });
      expect(unmatched.status).toBe(200);
      expect(unmatched.body.order.explainerMatched).toBe(false);

      const persistedUnmatched = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(persistedUnmatched.explainerAgencyId).toBeNull();

      await prisma.agency.delete({ where: { id: agency.id } });
    });
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

    it('残課題指示書Stage5: 紹介コードありの銀行振込入金確認でreferral_confirm_purchaseジョブが記録される', async () => {
      const order = await prisma.order.create({
        data: {
          orderNumber: `SG-BANKTRANSFERTEST-CONFIRM-${Date.now()}`,
          totalAmount: 10000,
          originalAmount: 10000,
          paymentStatus: 'pending',
          orderStatus: 'pending',
          paymentMethod: 'bank_transfer',
          customerName: '入金確認次郎',
          customerEmail: `admin-orders-test-banktransfer-confirm-${Date.now()}@example.com`,
          termsAgreedAt: new Date(),
          termsVersion: '2026-07-01',
          referralCode: 'SGI9001',
        },
      });

      const { agent } = await createAdminAgent(app);
      const res = await agent.post(`/api/admin/orders/${order.id}/confirm-bank-transfer`).set('Origin', TEST_ORIGIN).send();
      expect(res.status).toBe(200);

      const jobs = await prisma.orderLinkingJob.findMany({ where: { orderId: order.id, jobType: 'referral_confirm_purchase' } });
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe('pending');

      await prisma.orderLinkingJob.deleteMany({ where: { orderId: order.id } });
      await prisma.order.delete({ where: { id: order.id } });
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

describe('注文一覧のページネーション(仕様書外の拡張・保守性改善Phase8)', () => {
  const emailMarker = `admin-orders-pagetest-${Date.now()}`;
  const TOTAL_ORDERS = 55;

  beforeAll(async () => {
    for (let i = 0; i < TOTAL_ORDERS; i++) {
      await prisma.order.create({
        data: {
          orderNumber: `SG-PAGETEST-${i}-${Date.now()}`,
          totalAmount: 1000,
          originalAmount: 1000,
          paymentStatus: 'paid',
          orderStatus: 'paid',
          customerName: `ページテスト${i}`,
          customerEmail: `${emailMarker}-${i}@example.com`,
          termsAgreedAt: new Date(),
          termsVersion: '2026-07-01',
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { customerEmail: { contains: emailMarker } } });
    await prisma.$disconnect();
  });

  it('既定のpageSize(50)で1ページ目にはpageSize件、totalには全件数が入る', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/orders').set('Origin', TEST_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body.orders.length).toBe(50);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(50);
    expect(res.body.total).toBeGreaterThanOrEqual(TOTAL_ORDERS);
  });

  it('page=2を指定すると2ページ目の残り件数が返る', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/orders').query({ page: 2 }).set('Origin', TEST_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.orders.length).toBeGreaterThan(0);
  });

  it('CSV出力(export.csv)はページネーションされず全件出力される', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/orders/export.csv').set('Origin', TEST_ORIGIN);

    expect(res.status).toBe(200);
    const rowCount = res.text.trim().split('\n').length - 1; // ヘッダー行を除く
    expect(rowCount).toBeGreaterThanOrEqual(TOTAL_ORDERS);
  });
});
