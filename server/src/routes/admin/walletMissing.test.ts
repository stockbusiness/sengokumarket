import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();

async function createViewerAgent() {
  const email = `wallet-missing-viewer-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const user = await prisma.user.create({
    data: { name: '閲覧専用管理者', email, passwordHash: await bcrypt.hash('viewerpassword1', 10), role: 'admin_viewer' },
  });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'viewerpassword1' });
  return { agent, userId: user.id };
}

describe('管理API: ウォレット未登録者への案内メール送信(仕様書外の拡張)', () => {
  let productId: string;
  let customerUserId: string;

  async function createNftIssue(opts: { withUser: boolean; status?: string }) {
    const order = await prisma.order.create({
      data: {
        orderNumber: `SG-WALLETMISSING-${Math.random().toString(36).slice(2)}`,
        userId: opts.withUser ? customerUserId : undefined,
        totalAmount: 10000,
        originalAmount: 10000,
        paymentStatus: 'paid',
        orderStatus: 'paid',
        customerName: 'ウォレット未登録テスト太郎',
        customerEmail: 'wallet-missing-test@example.com',
        termsAgreedAt: new Date(),
        termsVersion: '2026-07-01',
      },
    });
    const orderItem = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId,
        productName: 'テスト商品',
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
        productId,
        userId: opts.withUser ? customerUserId : undefined,
        status: opts.status ?? 'wallet_required',
      },
    });
  }

  beforeAll(async () => {
    const product = await prisma.product.create({
      data: {
        name: 'wallet-missing-test商品',
        slug: `wallet-missing-test-${Date.now()}`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 10000,
        status: 'published',
      },
    });
    productId = product.id;

    const customer = await prisma.user.create({
      data: {
        name: 'ウォレット未登録テスト太郎',
        email: `wallet-missing-customer-${Date.now()}@example.com`,
        passwordHash: await bcrypt.hash('customerpassword1', 10),
      },
    });
    customerUserId = customer.id;
  });

  afterAll(async () => {
    await prisma.walletReminderEmail.deleteMany({ where: { nftIssue: { productId } } });
    await prisma.nftIssue.deleteMany({ where: { productId } });
    await prisma.orderItem.deleteMany({ where: { productId } });
    await prisma.order.deleteMany({ where: { customerEmail: 'wallet-missing-test@example.com' } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.user.delete({ where: { id: customerUserId } });
    await prisma.user.deleteMany({ where: { email: { contains: 'wallet-missing-viewer-test' } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  it('一覧には最終案内メール送信日時がnullで含まれる', async () => {
    const issue = await createNftIssue({ withUser: true });
    const { agent } = await createAdminAgent(app);

    const res = await agent.get('/api/admin/wallet-missing');
    expect(res.status).toBe(200);
    const row = res.body.walletMissing.find((r: { id: string }) => r.id === issue.id);
    expect(row).toBeDefined();
    expect(row.lastReminderSentAt).toBeNull();
  });

  it('案内メールを送信すると送信記録が作成され、一覧の最終送信日時が更新される', async () => {
    const issue = await createNftIssue({ withUser: true });
    const { agent, userId: adminUserId } = await createAdminAgent(app);

    const sendRes = await agent.post(`/api/admin/wallet-missing/${issue.id}/reminder`).set('Origin', TEST_ORIGIN);
    expect(sendRes.status).toBe(201);
    expect(sendRes.body.lastReminderSentAt).not.toBeNull();

    const logs = await prisma.walletReminderEmail.findMany({ where: { nftIssueId: issue.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].sentBy).toBe(adminUserId);

    const listRes = await agent.get('/api/admin/wallet-missing');
    const row = listRes.body.walletMissing.find((r: { id: string }) => r.id === issue.id);
    expect(row.lastReminderSentAt).not.toBeNull();
  });

  it('再送信すると送信記録が追加され、一覧には最新の送信日時のみ表示される', async () => {
    const issue = await createNftIssue({ withUser: true });
    const { agent } = await createAdminAgent(app);

    await agent.post(`/api/admin/wallet-missing/${issue.id}/reminder`).set('Origin', TEST_ORIGIN);
    const secondRes = await agent.post(`/api/admin/wallet-missing/${issue.id}/reminder`).set('Origin', TEST_ORIGIN);
    expect(secondRes.status).toBe(201);

    const logs = await prisma.walletReminderEmail.findMany({ where: { nftIssueId: issue.id } });
    expect(logs).toHaveLength(2);
  });

  it('送信記録を削除すると一覧の最終送信日時がnullに戻る', async () => {
    const issue = await createNftIssue({ withUser: true });
    const { agent } = await createAdminAgent(app);

    await agent.post(`/api/admin/wallet-missing/${issue.id}/reminder`).set('Origin', TEST_ORIGIN);
    const deleteRes = await agent.delete(`/api/admin/wallet-missing/${issue.id}/reminder`).set('Origin', TEST_ORIGIN);
    expect(deleteRes.status).toBe(204);

    const logs = await prisma.walletReminderEmail.findMany({ where: { nftIssueId: issue.id } });
    expect(logs).toHaveLength(0);

    const listRes = await agent.get('/api/admin/wallet-missing');
    const row = listRes.body.walletMissing.find((r: { id: string }) => r.id === issue.id);
    expect(row.lastReminderSentAt).toBeNull();
  });

  it('会員アカウントに紐づいていない場合は400を返す', async () => {
    const issue = await createNftIssue({ withUser: false });
    const { agent } = await createAdminAgent(app);

    const res = await agent.post(`/api/admin/wallet-missing/${issue.id}/reminder`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(400);
  });

  it('wallet_required以外の状態には404を返す', async () => {
    const issue = await createNftIssue({ withUser: true, status: 'ready_to_issue' });
    const { agent } = await createAdminAgent(app);

    const res = await agent.post(`/api/admin/wallet-missing/${issue.id}/reminder`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(404);
  });

  it('存在しないIDには404を返す', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .post('/api/admin/wallet-missing/00000000-0000-0000-0000-000000000000/reminder')
      .set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(404);
  });

  it('閲覧専用管理者(admin_viewer)は送信・削除ができず403を返す', async () => {
    const issue = await createNftIssue({ withUser: true });
    const { agent } = await createViewerAgent();

    const sendRes = await agent.post(`/api/admin/wallet-missing/${issue.id}/reminder`).set('Origin', TEST_ORIGIN);
    expect(sendRes.status).toBe(403);

    const deleteRes = await agent.delete(`/api/admin/wallet-missing/${issue.id}/reminder`).set('Origin', TEST_ORIGIN);
    expect(deleteRes.status).toBe(403);
  });
});
