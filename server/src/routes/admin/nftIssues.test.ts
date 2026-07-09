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
});
