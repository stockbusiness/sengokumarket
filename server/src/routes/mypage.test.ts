import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const app = createApp();
const ORIGIN = 'http://localhost:5173';
const VALID_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

describe('マイページAPI', () => {
  let userId: string;
  let otherUserId: string;
  let productId: string;
  let variantId: string;
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    const email = `mypage-test-${Date.now()}@example.com`;
    agent = request.agent(app);
    const registerRes = await agent
      .post('/api/auth/register')
      .set('Origin', ORIGIN)
      .send({ name: 'マイページ太郎', email, password: 'password123' });
    userId = registerRes.body.user.id;

    const otherEmail = `mypage-other-test-${Date.now()}@example.com`;
    const otherRes = await request(app)
      .post('/api/auth/register')
      .set('Origin', ORIGIN)
      .send({ name: '他人', email: otherEmail, password: 'password123' });
    otherUserId = otherRes.body.user.id;

    const product = await prisma.product.create({
      data: {
        name: 'マイページテスト商品',
        slug: `mypage-test-product-${Date.now()}`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 15000,
        status: 'published',
      },
    });
    productId = product.id;
    const variant = await prisma.productVariant.create({
      data: { productId, name: 'Black', price: 15000, stock: 10 },
    });
    variantId = variant.id;

    await prisma.notice.create({
      data: { title: '公開済みお知らせ', body: '本文', status: 'published', publishedAt: new Date() },
    });
    await prisma.notice.create({
      data: { title: '下書きお知らせ', body: '本文', status: 'draft' },
    });
  });

  afterAll(async () => {
    await prisma.nftIssue.deleteMany({ where: { productId } });
    await prisma.orderItem.deleteMany({ where: { productId } });
    await prisma.order.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.notice.deleteMany({ where: { title: { in: ['公開済みお知らせ', '下書きお知らせ'] } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  async function createOrderWithNft(ownerId: string, nftStatus: string) {
    const order = await prisma.order.create({
      data: {
        orderNumber: `SG-TEST-${Math.random().toString(36).slice(2)}`,
        userId: ownerId,
        totalAmount: 15000,
        paymentStatus: 'paid',
        orderStatus: 'paid',
        customerName: 'テスト',
        customerEmail: 'test@example.com',
        termsAgreedAt: new Date(),
        termsVersion: '2026-07-01',
      },
    });
    const orderItem = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId,
        variantId,
        productName: 'マイページテスト商品',
        variantName: 'Black',
        itemType: 'nft',
        quantity: 1,
        unitPrice: 15000,
        subtotal: 15000,
      },
    });
    const nftIssue = await prisma.nftIssue.create({
      data: {
        orderId: order.id,
        orderItemId: orderItem.id,
        userId: ownerId,
        productId,
        variantId,
        status: nftStatus,
      },
    });
    return { order, nftIssue };
  }

  it('未認証では401を返す', async () => {
    const res = await request(app).get('/api/mypage/orders');
    expect(res.status).toBe(401);
  });

  it('自分の注文のみ取得できる(他人の注文は含まれない)', async () => {
    await createOrderWithNft(userId, 'wallet_required');
    await createOrderWithNft(otherUserId, 'wallet_required');

    const res = await agent.get('/api/mypage/orders');
    expect(res.status).toBe(200);
    expect(res.body.orders.length).toBeGreaterThan(0);
    expect(res.body.orders.every((o: { totalAmount: number }) => o.totalAmount === 15000)).toBe(true);
    expect(res.body.orders[0].items[0].productName).toBe('マイページテスト商品');
  });

  it('自分の注文は1件詳細取得でき、他人の注文はNOT_FOUNDになる(領収書表示用)', async () => {
    const { order: myOrder } = await createOrderWithNft(userId, 'wallet_required');
    const { order: otherOrder } = await createOrderWithNft(otherUserId, 'wallet_required');

    const okRes = await agent.get(`/api/mypage/orders/${myOrder.id}`);
    expect(okRes.status).toBe(200);
    expect(okRes.body.order.customerName).toBe('テスト');
    expect(okRes.body.order.items[0].productName).toBe('マイページテスト商品');

    const forbiddenRes = await agent.get(`/api/mypage/orders/${otherOrder.id}`);
    expect(forbiddenRes.status).toBe(404);
  });

  it('自分のNFT発行状況のみ取得できる', async () => {
    const res = await agent.get('/api/mypage/nfts');
    expect(res.status).toBe(200);
    expect(res.body.nftIssues.length).toBeGreaterThan(0);
    expect(res.body.nftIssues.every((n: { status: string }) => n.status === 'wallet_required')).toBe(true);
  });

  it('公開済みのお知らせのみ取得できる', async () => {
    const res = await agent.get('/api/mypage/notices');
    expect(res.status).toBe(200);
    const titles = res.body.notices.map((n: { title: string }) => n.title);
    expect(titles).toContain('公開済みお知らせ');
    expect(titles).not.toContain('下書きお知らせ');
  });

  it('お知らせは既定で未読、既読にするとread=trueになり他人には影響しない', async () => {
    const before = await agent.get('/api/mypage/notices');
    const notice = before.body.notices.find((n: { title: string }) => n.title === '公開済みお知らせ');
    expect(notice.read).toBe(false);

    const markRes = await agent.post(`/api/mypage/notices/${notice.id}/read`).set('Origin', ORIGIN);
    expect(markRes.status).toBe(200);

    const after = await agent.get('/api/mypage/notices');
    expect(after.body.notices.find((n: { id: string }) => n.id === notice.id).read).toBe(true);

    const otherAgent = request.agent(app);
    const otherEmail = `mypage-otherread-test-${Date.now()}@example.com`;
    await otherAgent.post('/api/auth/register').set('Origin', ORIGIN).send({ name: '他人2', email: otherEmail, password: 'password123' });
    const otherView = await otherAgent.get('/api/mypage/notices');
    expect(otherView.body.notices.find((n: { id: string }) => n.id === notice.id).read).toBe(false);

    await prisma.user.deleteMany({ where: { email: otherEmail } });
  });

  it('氏名・電話番号を編集できる', async () => {
    const res = await agent.put('/api/mypage/profile').set('Origin', ORIGIN).send({ name: '改名太郎', phone: '080-9999-8888' });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('改名太郎');
    expect(res.body.user.phone).toBe('080-9999-8888');

    const meRes = await agent.get('/api/auth/me');
    expect(meRes.body.user.name).toBe('改名太郎');
  });

  it('氏名を空にすると400を返す', async () => {
    const res = await agent.put('/api/mypage/profile').set('Origin', ORIGIN).send({ name: '  ', phone: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('不正な形式のウォレットアドレスは400を返す', async () => {
    const res = await agent.post('/api/mypage/wallet').set('Origin', ORIGIN).send({ walletAddress: '0xshort' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('ウォレット登録でwallet_requiredのnft_issuesがready_to_issueに一括更新される(issued/failedは変更しない)', async () => {
    const { nftIssue: issuedNft } = await createOrderWithNft(userId, 'issued');
    const { nftIssue: failedNft } = await createOrderWithNft(userId, 'failed');

    const res = await agent
      .post('/api/mypage/wallet')
      .set('Origin', ORIGIN)
      .send({ walletAddress: VALID_ADDRESS, chain: 'polygon' });

    expect(res.status).toBe(200);
    expect(res.body.wallet.walletAddress).toBe(VALID_ADDRESS);

    const walletRes = await agent.get('/api/mypage/wallet');
    expect(walletRes.body.wallet.walletAddress).toBe(VALID_ADDRESS);

    const updatedIssues = await prisma.nftIssue.findMany({ where: { userId } });
    const previouslyWalletRequired = updatedIssues.filter(
      (n) => n.id !== issuedNft.id && n.id !== failedNft.id,
    );
    expect(previouslyWalletRequired.every((n) => n.status === 'ready_to_issue' && n.walletAddress === VALID_ADDRESS)).toBe(
      true,
    );

    const issuedAfter = updatedIssues.find((n) => n.id === issuedNft.id)!;
    const failedAfter = updatedIssues.find((n) => n.id === failedNft.id)!;
    expect(issuedAfter.status).toBe('issued');
    expect(issuedAfter.walletAddress).toBeNull();
    expect(failedAfter.status).toBe('failed');
    expect(failedAfter.walletAddress).toBeNull();
  });
});
