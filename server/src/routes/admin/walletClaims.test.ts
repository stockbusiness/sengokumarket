import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';
import { setSetting } from '../../services/settings';
import { hashClaimToken } from '../../services/walletClaim';
import { dispatchPendingNotifications } from '../../modules/notifications/application/dispatchNotificationOutbox.usecase';

const sendNotificationOrThrowMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../../modules/notifications/application/sendNotification.usecase', () => ({
  sendNotification: async (..._args: unknown[]) => {},
  sendNotificationOrThrow: (...args: unknown[]) => sendNotificationOrThrowMock(...args),
}));

const app = createApp();
const PRODUCT_PREFIX = 'admin-wallet-claim-route-test-product-';
const ORDER_PREFIX = 'SG-ADMINWCTEST-';

async function createFixture(suffix: string, status = 'PENDING') {
  const product = await prisma.product.create({
    data: {
      name: `${PRODUCT_PREFIX}${suffix}`,
      slug: `${PRODUCT_PREFIX}${suffix}`,
      category: 'テスト',
      itemType: 'nft',
      basePrice: 10000,
      status: 'published',
    },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `${ORDER_PREFIX}${suffix}`,
      totalAmount: 10000,
      originalAmount: 10000,
      paymentStatus: 'paid',
      orderStatus: 'paid',
      customerName: '管理画面テスト太郎',
      customerEmail: `admin-wc-test-${suffix}@example.com`,
      termsAgreedAt: new Date(),
      termsVersion: '2026-07-01',
      commonUserId: 'cu_test_00000001',
    },
  });
  const orderItem = await prisma.orderItem.create({
    data: { orderId: order.id, productId: product.id, productName: product.name, itemType: 'nft', quantity: 1, unitPrice: 10000, subtotal: 10000 },
  });
  const nftIssue = await prisma.nftIssue.create({
    data: { orderId: order.id, orderItemId: orderItem.id, productId: product.id, status: 'wallet_required', serialNumber: 1 },
  });
  const claim = await prisma.walletClaim.create({
    data: {
      orderId: order.id,
      tokenHash: hashClaimToken(`admin-wc-test-token-${suffix}`),
      status,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
      commonUserId: status !== 'PENDING' ? 'cu_test_00000001' : null,
    },
  });
  return { product, order, orderItem, nftIssue, claim };
}

async function cleanup(orderId: string, productId: string) {
  await prisma.collectibleDelivery.deleteMany({ where: { walletClaim: { orderId } } });
  await prisma.walletClaimAuditLog.deleteMany({ where: { orderId } });
  await prisma.walletClaim.deleteMany({ where: { orderId } });
  await prisma.nftIssue.deleteMany({ where: { orderId } });
  await prisma.orderItem.deleteMany({ where: { orderId } });
  await prisma.order.deleteMany({ where: { id: orderId } });
  await prisma.product.deleteMany({ where: { id: productId } });
}

describe('管理API: /admin/wallet-claims(戦国マーケットNFTカード受取・送付19章)', () => {
  afterAll(async () => {
    await prisma.setting.deleteMany({ where: { key: 'wallet_claim_web_base_url' } });
    await prisma.$disconnect();
  });

  it('未認証は401', async () => {
    const res = await request(app).get('/api/admin/wallet-claims');
    expect(res.status).toBe(401);
  });

  it('管理者は一覧取得・orderNumberで絞り込みできる。生Tokenは含まれない', async () => {
    const { agent } = await createAdminAgent(app);
    const { order, product } = await createFixture(`list-${Date.now()}`);

    const res = await agent.get(`/api/admin/wallet-claims?orderNumber=${order.orderNumber}`);
    expect(res.status).toBe(200);
    expect(res.body.walletClaims).toHaveLength(1);
    expect(res.body.walletClaims[0].orderNumber).toBe(order.orderNumber);
    expect(JSON.stringify(res.body)).not.toContain('tokenHash');
    expect(JSON.stringify(res.body)).not.toContain('token_hash');

    await cleanup(order.id, product.id);
  });

  it('詳細取得でdeliveries・auditLogsを含む(生Tokenは含まれない)', async () => {
    const { agent } = await createAdminAgent(app);
    const { order, product, claim } = await createFixture(`detail-${Date.now()}`, 'DELIVERY_PENDING');
    await prisma.walletClaimAuditLog.create({ data: { walletClaimId: claim.id, orderId: order.id, eventType: 'claim_confirmed' } });

    const res = await agent.get(`/api/admin/wallet-claims/${claim.id}`);
    expect(res.status).toBe(200);
    expect(res.body.walletClaim.auditLogs).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain('tokenHash');

    await cleanup(order.id, product.id);
  });

  // Wallet Claim本番前安定化指示書(2026-07-25)Phase7(9章「時刻カラム分離」): claimedAt/
  // deliveredAt/revokedAt/manualReviewRequiredAtが独立して一覧・詳細の両方に表示される。
  it('一覧・詳細にdeliveredAt・revokedAt・manualReviewRequiredAtが独立して含まれる', async () => {
    const { agent } = await createAdminAgent(app);
    const { order, product, claim } = await createFixture(`timestamps-${Date.now()}`, 'MANUAL_REVIEW_REQUIRED');
    const claimedAt = new Date(Date.now() - 3000);
    const manualReviewRequiredAt = new Date(Date.now() - 1000);
    await prisma.walletClaim.update({
      where: { id: claim.id },
      data: { claimedAt, manualReviewRequiredAt, deliveredAt: null, revokedAt: null },
    });

    const listRes = await agent.get(`/api/admin/wallet-claims?orderNumber=${order.orderNumber}`);
    expect(listRes.status).toBe(200);
    expect(new Date(listRes.body.walletClaims[0].claimedAt).getTime()).toBe(claimedAt.getTime());
    expect(listRes.body.walletClaims[0].deliveredAt).toBeNull();
    expect(new Date(listRes.body.walletClaims[0].manualReviewRequiredAt).getTime()).toBe(manualReviewRequiredAt.getTime());

    const detailRes = await agent.get(`/api/admin/wallet-claims/${claim.id}`);
    expect(detailRes.status).toBe(200);
    expect(new Date(detailRes.body.walletClaim.claimedAt).getTime()).toBe(claimedAt.getTime());
    expect(detailRes.body.walletClaim.revokedAt).toBeNull();
    expect(new Date(detailRes.body.walletClaim.manualReviewRequiredAt).getTime()).toBe(manualReviewRequiredAt.getTime());

    await cleanup(order.id, product.id);
  });

  it('存在しないIDの詳細取得は404', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/wallet-claims/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('再発行: PENDINGのClaimはNotification Outbox経由でメール送信され、生Tokenを画面へ返さない', async () => {
    await setSetting('wallet_claim_web_base_url', 'https://wallet.example.com');
    const { agent } = await createAdminAgent(app);
    const { order, product, claim } = await createFixture(`reissue-ok-${Date.now()}`);
    sendNotificationOrThrowMock.mockClear();

    const res = await agent.post(`/api/admin/wallet-claims/${claim.id}/reissue`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.queued).toBe(true);
    expect(res.body.sentTo).toBe(order.customerEmail);
    expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{64}/); // 64桁16進の生トークンが含まれない

    // Notification Outbox経由でDispatcherが実際にToken発行・送信を行う(即時トリガーで完了する)。
    // 1回のdispatchPendingNotifications呼び出しはBATCH_LIMIT件までしか処理しないため、
    // フルスイート実行時は他テストが積んだ古いpendingイベントが先に消化され、この注文向けの
    // イベントが同じ呼び出し内で処理されないことがある。その場合は成功するまで追加でdispatchする。
    let event = await prisma.notificationOutboxEvent.findFirstOrThrow({
      where: { recipient: order.customerEmail, eventType: 'wallet_claim_reissued' },
    });
    for (let i = 0; i < 5 && event.status !== 'succeeded'; i++) {
      await dispatchPendingNotifications();
      event = await prisma.notificationOutboxEvent.findFirstOrThrow({ where: { id: event.id } });
    }
    expect(event.status).toBe('succeeded');
    expect(sendNotificationOrThrowMock).toHaveBeenCalledWith(expect.objectContaining({ to: order.customerEmail }), expect.any(String));

    const updatedClaim = await prisma.walletClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(updatedClaim.tokenHash).not.toBe(claim.tokenHash);
    expect(updatedClaim.reissueCount).toBe(1);

    const auditLogs = await prisma.walletClaimAuditLog.findMany({ where: { walletClaimId: claim.id } });
    expect(auditLogs.some((a) => a.eventType === 'reissue_requested_by_admin')).toBe(true);

    await cleanup(order.id, product.id);
  });

  // 最終安定化指示書Phase2「受入条件」: 連打対策(同一Claimにpending/processingの再発行通知が
  // 既にある場合は新規作成しない)。
  it('再発行連打: 直前の再発行通知がまだpending/processingの間は、新規イベントを作らずに既存のqueued応答を返す', async () => {
    await setSetting('wallet_claim_web_base_url', 'https://wallet.example.com');
    const { agent } = await createAdminAgent(app);
    const { order, product, claim } = await createFixture(`reissue-double-click-${Date.now()}`);

    // 1回目のリクエストの直前に、まだ処理されていないpendingの再発行通知が既にある状態を再現する
    // (dispatchが間に合わなかった/連打された状況)。
    await prisma.notificationOutboxEvent.create({
      data: {
        eventType: 'wallet_claim_reissued',
        recipient: order.customerEmail,
        payload: { orderId: order.id },
        status: 'pending',
      },
    });

    const res = await agent.post(`/api/admin/wallet-claims/${claim.id}/reissue`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(true);

    const events = await prisma.notificationOutboxEvent.findMany({
      where: { recipient: order.customerEmail, eventType: 'wallet_claim_reissued' },
    });
    expect(events).toHaveLength(1); // 新規enqueueされていない

    const auditLogs = await prisma.walletClaimAuditLog.findMany({ where: { walletClaimId: claim.id } });
    expect(auditLogs.some((a) => a.eventType === 'reissue_requested_by_admin')).toBe(false);

    await prisma.notificationOutboxEvent.deleteMany({ where: { recipient: order.customerEmail } });
    await cleanup(order.id, product.id);
  });

  it('再発行: DELIVERY_PENDING以降のClaimは再発行できない(400)', async () => {
    const { agent } = await createAdminAgent(app);
    const { order, product, claim } = await createFixture(`reissue-ng-${Date.now()}`, 'DELIVERY_PENDING');

    const res = await agent.post(`/api/admin/wallet-claims/${claim.id}/reissue`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(400);

    await cleanup(order.id, product.id);
  });

  it('スタッフ(staff)はこの画面にアクセスできない(403)', async () => {
    const { prisma: p } = await import('../../lib/prisma');
    const bcrypt = (await import('bcryptjs')).default;
    const email = `admin-wc-staff-test-${Date.now()}@example.com`;
    await p.user.create({ data: { name: 'スタッフ', email, passwordHash: await bcrypt.hash('staffpassword1', 10), role: 'staff' } });
    const agent = request.agent(app);
    await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'staffpassword1' });

    const res = await agent.get('/api/admin/wallet-claims');
    expect(res.status).toBe(403);

    await p.user.deleteMany({ where: { email } });
  });
});
