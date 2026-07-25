import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { createPendingOrder } from '../services/checkout';

const syncAgencyHierarchyFromExternalSystem = vi.fn(async () => ({ agenciesSynced: 2, applicationsApproved: 0 }));

vi.mock('../services/agencyHierarchySync', () => ({
  syncAgencyHierarchyFromExternalSystem: () => syncAgencyHierarchyFromExternalSystem(),
}));

const processNftMints = vi.fn(async () => ({ claimed: 1, issued: 1, stillProcessing: 0, retrying: 0, failed: 0, skipped: 0 }));

vi.mock('../services/nftMintProcessing', () => ({
  processNftMints: () => processNftMints(),
}));

const dispatchPendingOutboxEvents = vi.fn(async () => ({ claimed: 0, succeeded: 0, retrying: 0, dead: 0, skipped: 0, blocked: 0 }));

vi.mock('../services/integrationOutboxDispatcher', () => ({
  dispatchPendingOutboxEvents: () => dispatchPendingOutboxEvents(),
}));

const processOrderLinkingJobs = vi.fn(async () => ({ claimed: 0, succeeded: 0, retrying: 0, dead: 0, skipped: 0 }));

vi.mock('../services/orderLinkingJobDispatcher', () => ({
  processOrderLinkingJobs: () => processOrderLinkingJobs(),
}));

const dispatchPendingNotifications = vi.fn(async () => ({ claimed: 0, succeeded: 0, retrying: 0, dead: 0 }));

vi.mock('../modules/notifications/application/dispatchNotificationOutbox.usecase', () => ({
  dispatchPendingNotifications: () => dispatchPendingNotifications(),
}));

const cleanupStaleRateLimitBuckets = vi.fn(async () => ({ deletedCount: 0 }));

vi.mock('../services/rateLimiter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/rateLimiter')>();
  return { ...actual, cleanupStaleRateLimitBuckets: () => cleanupStaleRateLimitBuckets() };
});

const app = createApp();

describe('内部cron: 外部代理店システム階層同期(仕様書外の拡張)', () => {
  const originalSecret = process.env.CRON_SECRET;

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it('CRON_SECRET未設定の場合は503', async () => {
    delete process.env.CRON_SECRET;
    const res = await request(app).get('/api/internal/cron/sync-agency-hierarchy');
    expect(res.status).toBe(503);
  });

  it('Authorizationヘッダーが一致しない場合は401', async () => {
    process.env.CRON_SECRET = 'test-cron-secret';
    const res = await request(app)
      .get('/api/internal/cron/sync-agency-hierarchy')
      .set('Authorization', 'Bearer wrong-secret');
    expect(res.status).toBe(401);
  });

  it('正しいCRON_SECRETで同期が実行される', async () => {
    process.env.CRON_SECRET = 'test-cron-secret';
    const res = await request(app)
      .get('/api/internal/cron/sync-agency-hierarchy')
      .set('Authorization', 'Bearer test-cron-secret');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ agenciesSynced: 2, applicationsApproved: 0 });
  });
});

describe('内部cron: 銀行振込注文の失効(仕様書外の拡張)', () => {
  let productId: string;
  let variantId: string;
  const originalSecret = process.env.CRON_SECRET;

  beforeAll(async () => {
    const product = await prisma.product.create({
      data: {
        name: '振込期限テスト商品',
        slug: `cron-banktransfer-test-${Date.now()}`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 10000,
        status: 'published',
      },
    });
    productId = product.id;
    const variant = await prisma.productVariant.create({
      data: { productId, name: 'A', price: 10000, stock: 10 },
    });
    variantId = variant.id;
  });

  afterAll(async () => {
    await prisma.orderItem.deleteMany({ where: { productId } });
    await prisma.order.deleteMany({ where: { customerEmail: { contains: 'cron-banktransfer-test' } } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.$disconnect();
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  async function createBankTransferOrder(email: string) {
    const { order } = await createPendingOrder({
      customerName: '振込テスト太郎',
      customerEmail: email,
      customerPhone: '090-0000-0000',
      customerPostalCode: '100-0001',
      customerAddress: '東京都千代田区1-1-1',
      agreedToTerms: true,
      items: [{ variantId, quantity: 1 }],
      paymentMethod: 'bank_transfer',
    });
    return order;
  }

  it('振込期限(7日)を過ぎたpendingの銀行振込注文は失効し在庫が解放される。期限内の注文はそのまま', async () => {
    process.env.CRON_SECRET = 'test-cron-secret-banktransfer';

    const overdueOrder = await createBankTransferOrder(`cron-banktransfer-test-overdue-${Date.now()}@example.com`);
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await prisma.order.update({ where: { id: overdueOrder.id }, data: { createdAt: eightDaysAgo } });

    const withinWindowOrder = await createBankTransferOrder(`cron-banktransfer-test-recent-${Date.now()}@example.com`);

    const res = await request(app)
      .get('/api/internal/cron/expire-bank-transfer-orders')
      .set('Authorization', 'Bearer test-cron-secret-banktransfer');
    expect(res.status).toBe(200);
    expect(res.body.expiredCount).toBeGreaterThanOrEqual(1);

    const updatedOverdue = await prisma.order.findUniqueOrThrow({ where: { id: overdueOrder.id } });
    expect(updatedOverdue.paymentStatus).toBe('expired');
    expect(updatedOverdue.expiredAt).not.toBeNull();

    const updatedRecent = await prisma.order.findUniqueOrThrow({ where: { id: withinWindowOrder.id } });
    expect(updatedRecent.paymentStatus).toBe('pending');

    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
    // 期限切れ注文の分だけ解放され、期限内の注文の仮引当(1)は残る
    expect(variant.reservedStock).toBe(1);
  });
});

describe('内部cron: NFT自動発行処理(仕様書外の拡張)', () => {
  const originalSecret = process.env.CRON_SECRET;

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
    processNftMints.mockClear();
  });

  it('CRON_SECRET未設定の場合は503', async () => {
    delete process.env.CRON_SECRET;
    const res = await request(app).get('/api/internal/cron/process-nft-mints');
    expect(res.status).toBe(503);
  });

  it('Authorizationヘッダーが一致しない場合は401', async () => {
    process.env.CRON_SECRET = 'test-cron-secret-nftmint';
    const res = await request(app)
      .get('/api/internal/cron/process-nft-mints')
      .set('Authorization', 'Bearer wrong-secret');
    expect(res.status).toBe(401);
    expect(processNftMints).not.toHaveBeenCalled();
  });

  it('正しいCRON_SECRETでprocessNftMintsが実行される', async () => {
    process.env.CRON_SECRET = 'test-cron-secret-nftmint';
    const res = await request(app)
      .get('/api/internal/cron/process-nft-mints')
      .set('Authorization', 'Bearer test-cron-secret-nftmint');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claimed: 1, issued: 1, stillProcessing: 0, retrying: 0, failed: 0, skipped: 0 });
    expect(processNftMints).toHaveBeenCalledTimes(1);
  });
});

// 仕様書外の拡張(千ノ国全体連携 2026-07-22指示書対応): Outbox dispatcherのcron配線確認。
// dispatchPendingOutboxEvents自体の送信ロジックはintegrationOutboxDispatcher.test.tsで検証済みのため、
// ここではcron認証・呼び出し配線のみ確認する。
describe('内部cron: 連携Outbox送信(仕様書外の拡張)', () => {
  const originalSecret = process.env.CRON_SECRET;

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
    dispatchPendingOutboxEvents.mockClear();
  });

  it('CRON_SECRET未設定の場合は503', async () => {
    delete process.env.CRON_SECRET;
    const res = await request(app).get('/api/internal/cron/process-integration-outbox');
    expect(res.status).toBe(503);
  });

  it('Authorizationヘッダーが一致しない場合は401', async () => {
    process.env.CRON_SECRET = 'test-cron-secret-outbox';
    const res = await request(app)
      .get('/api/internal/cron/process-integration-outbox')
      .set('Authorization', 'Bearer wrong-secret');
    expect(res.status).toBe(401);
    expect(dispatchPendingOutboxEvents).not.toHaveBeenCalled();
  });

  it('正しいCRON_SECRETでdispatchPendingOutboxEventsが実行される', async () => {
    process.env.CRON_SECRET = 'test-cron-secret-outbox';
    const res = await request(app)
      .get('/api/internal/cron/process-integration-outbox')
      .set('Authorization', 'Bearer test-cron-secret-outbox');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claimed: 0, succeeded: 0, retrying: 0, dead: 0, skipped: 0, blocked: 0 });
    expect(dispatchPendingOutboxEvents).toHaveBeenCalledTimes(1);
  });
});

// 残課題指示書Stage3の拡張: 代理店設定メール等のnotification_outbox_events送信cron配線確認。
// dispatchPendingNotifications自体の送信ロジックはdispatchNotificationOutbox.usecase.test.tsで
// 検証済みのため、ここではcron認証・呼び出し配線のみ確認する。
describe('内部cron: 代理店通知Outbox送信(残課題指示書Stage3)', () => {
  const originalSecret = process.env.CRON_SECRET;

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
    dispatchPendingNotifications.mockClear();
  });

  it('CRON_SECRET未設定の場合は503', async () => {
    delete process.env.CRON_SECRET;
    const res = await request(app).get('/api/internal/cron/process-notification-outbox');
    expect(res.status).toBe(503);
  });

  it('Authorizationヘッダーが一致しない場合は401', async () => {
    process.env.CRON_SECRET = 'test-cron-secret-notification';
    const res = await request(app)
      .get('/api/internal/cron/process-notification-outbox')
      .set('Authorization', 'Bearer wrong-secret');
    expect(res.status).toBe(401);
    expect(dispatchPendingNotifications).not.toHaveBeenCalled();
  });

  it('正しいCRON_SECRETでdispatchPendingNotificationsが実行される', async () => {
    process.env.CRON_SECRET = 'test-cron-secret-notification';
    const res = await request(app)
      .get('/api/internal/cron/process-notification-outbox')
      .set('Authorization', 'Bearer test-cron-secret-notification');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claimed: 0, succeeded: 0, retrying: 0, dead: 0 });
    expect(dispatchPendingNotifications).toHaveBeenCalledTimes(1);
  });
});

// 残課題指示書Stage4の拡張: common_user_id解決・referral captureのorder_linking_jobs送信cron配線確認。
// processOrderLinkingJobs自体の送信ロジックはorderLinkingJobDispatcher.test.tsで検証済みのため、
// ここではcron認証・呼び出し配線のみ確認する。
describe('内部cron: 共通ID・紹介連携ジョブ送信(残課題指示書Stage4)', () => {
  const originalSecret = process.env.CRON_SECRET;

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
    processOrderLinkingJobs.mockClear();
  });

  it('CRON_SECRET未設定の場合は503', async () => {
    delete process.env.CRON_SECRET;
    const res = await request(app).get('/api/internal/cron/process-order-linking-jobs');
    expect(res.status).toBe(503);
  });

  it('Authorizationヘッダーが一致しない場合は401', async () => {
    process.env.CRON_SECRET = 'test-cron-secret-order-linking';
    const res = await request(app)
      .get('/api/internal/cron/process-order-linking-jobs')
      .set('Authorization', 'Bearer wrong-secret');
    expect(res.status).toBe(401);
    expect(processOrderLinkingJobs).not.toHaveBeenCalled();
  });

  it('正しいCRON_SECRETでprocessOrderLinkingJobsが実行される', async () => {
    process.env.CRON_SECRET = 'test-cron-secret-order-linking';
    const res = await request(app)
      .get('/api/internal/cron/process-order-linking-jobs')
      .set('Authorization', 'Bearer test-cron-secret-order-linking');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claimed: 0, succeeded: 0, retrying: 0, dead: 0, skipped: 0 });
    expect(processOrderLinkingJobs).toHaveBeenCalledTimes(1);
  });
});

// 本番安定化指示書Stage3(6.7): 古いrate_limit_buckets行の掃除cron配線確認。
// cleanupStaleRateLimitBuckets自体の削除ロジックはrateLimiter.test.tsで検証済みのため、
// ここではcron認証・呼び出し配線のみ確認する。
describe('内部cron: レート制限bucketの掃除(本番安定化指示書Stage3)', () => {
  const originalSecret = process.env.CRON_SECRET;

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
    cleanupStaleRateLimitBuckets.mockClear();
  });

  it('CRON_SECRET未設定の場合は503', async () => {
    delete process.env.CRON_SECRET;
    const res = await request(app).get('/api/internal/cron/cleanup-rate-limit-buckets');
    expect(res.status).toBe(503);
  });

  it('Authorizationヘッダーが一致しない場合は401', async () => {
    process.env.CRON_SECRET = 'test-cron-secret-ratelimit-cleanup';
    const res = await request(app)
      .get('/api/internal/cron/cleanup-rate-limit-buckets')
      .set('Authorization', 'Bearer wrong-secret');
    expect(res.status).toBe(401);
    expect(cleanupStaleRateLimitBuckets).not.toHaveBeenCalled();
  });

  it('正しいCRON_SECRETでcleanupStaleRateLimitBucketsが実行される', async () => {
    process.env.CRON_SECRET = 'test-cron-secret-ratelimit-cleanup';
    const res = await request(app)
      .get('/api/internal/cron/cleanup-rate-limit-buckets')
      .set('Authorization', 'Bearer test-cron-secret-ratelimit-cleanup');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deletedCount: 0 });
    expect(cleanupStaleRateLimitBuckets).toHaveBeenCalledTimes(1);
  });
});
