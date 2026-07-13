import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();
const VALID_TX_HASH = `0x${'a'.repeat(64)}`;

describe('管理API: NFT発行管理', () => {
  let productId: string;
  let nftIssueId: string;

  beforeAll(async () => {
    const product = await prisma.product.create({
      data: {
        name: 'admin-nft-test商品',
        slug: `admin-nft-test-${Date.now()}`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 10000,
        status: 'published',
      },
    });
    productId = product.id;
    const variant = await prisma.productVariant.create({
      data: { productId, name: 'A', price: 10000, stock: 5 },
    });

    const order = await prisma.order.create({
      data: {
        orderNumber: `SG-NFTADMIN-${Date.now()}`,
        totalAmount: 10000,
        originalAmount: 10000,
        paymentStatus: 'paid',
        orderStatus: 'paid',
        customerName: 'テスト',
        customerEmail: 'admin-nft-test@example.com',
        termsAgreedAt: new Date(),
        termsVersion: '2026-07-01',
      },
    });
    const orderItem = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId,
        variantId: variant.id,
        productName: product.name,
        variantName: variant.name,
        itemType: 'nft',
        quantity: 1,
        unitPrice: 10000,
        subtotal: 10000,
      },
    });
    const nftIssue = await prisma.nftIssue.create({
      data: { orderId: order.id, orderItemId: orderItem.id, productId, variantId: variant.id, status: 'ready_to_issue' },
    });
    nftIssueId = nftIssue.id;
  });

  afterAll(async () => {
    await prisma.nftIssue.deleteMany({ where: { productId } });
    await prisma.orderItem.deleteMany({ where: { productId } });
    await prisma.order.deleteMany({ where: { customerEmail: 'admin-nft-test@example.com' } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  it('token_id / transaction_hashなしでissuedに変更しようとすると400', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.put(`/api/admin/nft-issues/${nftIssueId}`).set('Origin', TEST_ORIGIN).send({ status: 'issued' });
    expect(res.status).toBe(400);
  });

  it('不正な形式のtransaction_hashは400', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .put(`/api/admin/nft-issues/${nftIssueId}`)
      .set('Origin', TEST_ORIGIN)
      .send({ status: 'issued', tokenId: '1', transactionHash: '0xshort' });
    expect(res.status).toBe(400);
  });

  it('token_id / transaction_hashを指定するとissuedになりissued_atが記録される', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .put(`/api/admin/nft-issues/${nftIssueId}`)
      .set('Origin', TEST_ORIGIN)
      .send({ status: 'issued', tokenId: '42', transactionHash: VALID_TX_HASH });

    expect(res.status).toBe(200);
    expect(res.body.nftIssue.status).toBe('issued');
    expect(res.body.nftIssue.issuedAt).not.toBeNull();

    const persisted = await prisma.nftIssue.findUniqueOrThrow({ where: { id: nftIssueId } });
    expect(persisted.tokenId).toBe('42');
  });

  it('statusでフィルタできる', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/nft-issues').query({ status: 'issued' });
    expect(res.status).toBe(200);
    expect(res.body.nftIssues.some((n: { id: string }) => n.id === nftIssueId)).toBe(true);
  });

  describe('再試行・保留(仕様書外の拡張・NFT自動発行)', () => {
    let productId2: string;

    async function createIssue(status: string, extra: Partial<{ attemptCount: number; nextAttemptAt: Date }> = {}) {
      const order = await prisma.order.create({
        data: {
          orderNumber: `SG-NFTADMINRETRY-${Math.random().toString(36).slice(2)}`,
          totalAmount: 10000,
          originalAmount: 10000,
          paymentStatus: 'paid',
          orderStatus: 'paid',
          customerName: 'テスト',
          customerEmail: 'admin-nft-test-retry@example.com',
          termsAgreedAt: new Date(),
          termsVersion: '2026-07-01',
        },
      });
      const orderItem = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: productId2,
          productName: 'テスト',
          itemType: 'nft',
          quantity: 1,
          unitPrice: 10000,
          subtotal: 10000,
        },
      });
      return prisma.nftIssue.create({
        data: {
          orderId: order.id,
          orderItemId: orderItem.id,
          productId: productId2,
          status,
          attemptCount: extra.attemptCount ?? 0,
          nextAttemptAt: extra.nextAttemptAt ?? null,
        },
      });
    }

    beforeAll(async () => {
      const product = await prisma.product.create({
        data: {
          name: 'admin-nft-retry-test商品',
          slug: `admin-nft-retry-test-${Date.now()}`,
          category: 'テスト',
          itemType: 'nft',
          basePrice: 10000,
          status: 'published',
        },
      });
      productId2 = product.id;
    });

    afterAll(async () => {
      await prisma.nftIssue.deleteMany({ where: { productId: productId2 } });
      await prisma.orderItem.deleteMany({ where: { productId: productId2 } });
      await prisma.order.deleteMany({ where: { customerEmail: 'admin-nft-test-retry@example.com' } });
      await prisma.product.delete({ where: { id: productId2 } });
    });

    it('failedの行を再試行するとready_to_issueに戻りnextAttemptAtがクリアされる', async () => {
      const issue = await createIssue('failed', { attemptCount: 5, nextAttemptAt: new Date(Date.now() + 60_000) });
      const { agent } = await createAdminAgent(app);

      const res = await agent.post(`/api/admin/nft-issues/${issue.id}/retry`).set('Origin', TEST_ORIGIN);
      expect(res.status).toBe(200);
      expect(res.body.nftIssue.status).toBe('ready_to_issue');
      expect(res.body.nftIssue.nextAttemptAt).toBeNull();
    });

    it('issued/cancelledの行は再試行できず400を返す', async () => {
      const issue = await createIssue('cancelled');
      const { agent } = await createAdminAgent(app);

      const res = await agent.post(`/api/admin/nft-issues/${issue.id}/retry`).set('Origin', TEST_ORIGIN);
      expect(res.status).toBe(400);
    });

    it('ready_to_issueの行を保留にするとnextAttemptAtが遠い未来に設定される', async () => {
      const issue = await createIssue('ready_to_issue');
      const { agent } = await createAdminAgent(app);

      const res = await agent.post(`/api/admin/nft-issues/${issue.id}/hold`).set('Origin', TEST_ORIGIN);
      expect(res.status).toBe(200);
      expect(res.body.nftIssue.status).toBe('ready_to_issue');
      expect(new Date(res.body.nftIssue.nextAttemptAt).getTime()).toBeGreaterThan(Date.now() + 365 * 24 * 60 * 60 * 1000);
    });

    it('存在しないIDへの再試行・保留は404を返す', async () => {
      const { agent } = await createAdminAgent(app);
      const retryRes = await agent.post('/api/admin/nft-issues/00000000-0000-0000-0000-000000000000/retry').set('Origin', TEST_ORIGIN);
      expect(retryRes.status).toBe(404);
      const holdRes = await agent.post('/api/admin/nft-issues/00000000-0000-0000-0000-000000000000/hold').set('Origin', TEST_ORIGIN);
      expect(holdRes.status).toBe(404);
    });
  });
});
