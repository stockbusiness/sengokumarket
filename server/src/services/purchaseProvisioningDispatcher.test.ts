import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { setSetting } from './settings';
import { enqueueProvisioningJobIfEligible, enqueueProvisioningRevokeJobIfApplicable } from './purchaseProvisioningJobs';
import {
  countPurchaseProvisioningBacklog,
  processPurchaseProvisioningJobs,
  reissueAgencyLoginUrl,
  retryPurchaseProvisioningJob,
  skipPurchaseProvisioningJob,
} from './purchaseProvisioningDispatcher';

// 購入後代理店システム連携実装指示書 PR-M2・M5・M6。order_linking_jobsのDispatcherテスト
// (orderLinkingJobDispatcher.test.ts)と同じ設計方針: Feature Flag無効時(既定)は既存フローに
// 一切影響しないことを最重要要件として確認する。
describe('purchaseProvisioningDispatcher(購入後代理店システム連携実装指示書)', () => {
  const originalProvisioningFlag = process.env.PURCHASE_PROVISIONING_ENABLED;
  const originalLoginFlag = process.env.AGENCY_PORTAL_LOGIN_ENABLED;
  const suffix = `ppj-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const createdOrderIds: string[] = [];
  const createdProductIds: string[] = [];

  async function createAgencyProduct(mode: 'agent_portal' | 'customer_portal' | 'none' = 'agent_portal') {
    const product = await prisma.product.create({
      data: {
        name: 'テスト代理店参加プラン',
        slug: `${suffix}-${createdProductIds.length}`,
        category: 'テスト',
        itemType: 'membership',
        basePrice: 30000,
        agencyAccessMode: mode,
        agencyRole: mode === 'agent_portal' ? 'participant' : null,
        agencyProductCode: mode === 'none' ? null : 'agency_entry_plan',
      },
    });
    createdProductIds.push(product.id);
    return product;
  }

  async function createOrder(opts: {
    productId: string;
    commonUserId?: string | null;
    paymentStatus?: string;
    agencyProvisioningStatus?: string;
  }) {
    const order = await prisma.order.create({
      data: {
        orderNumber: `SG-PPJTEST-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        totalAmount: 30000,
        originalAmount: 30000,
        paymentStatus: opts.paymentStatus ?? 'paid',
        orderStatus: 'paid',
        customerName: 'PPJテスト太郎',
        customerEmail: `${suffix}@example.com`,
        termsAgreedAt: new Date(),
        termsVersion: '2026-07-01',
        commonUserId: opts.commonUserId ?? null,
        agencyProvisioningStatus: opts.agencyProvisioningStatus ?? 'not_applicable',
        orderItems: {
          create: {
            productId: opts.productId,
            productName: 'テスト代理店参加プラン',
            itemType: 'membership',
            quantity: 1,
            unitPrice: 30000,
            subtotal: 30000,
          },
        },
      },
    });
    createdOrderIds.push(order.id);
    return order;
  }

  beforeAll(async () => {
    // vitest.config.tsのfileParallelism:falseによりテストファイルは直列実行される
    // (orderLinkingJobDispatcher.test.ts同様、他ファイルの残骸を持ち越さないための掃除)。
    await prisma.purchaseProvisioningJob.deleteMany({ where: { status: 'pending' } });
  });

  beforeEach(() => {
    delete process.env.PURCHASE_PROVISIONING_ENABLED;
    delete process.env.AGENCY_PORTAL_LOGIN_ENABLED;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.env.PURCHASE_PROVISIONING_ENABLED = originalProvisioningFlag;
    process.env.AGENCY_PORTAL_LOGIN_ENABLED = originalLoginFlag;
    await prisma.setting.deleteMany({
      where: { key: { in: ['purchase_provisioning_hmac_key_id', 'purchase_provisioning_hmac_secret', 'purchase_provisioning_base_url'] } },
    });
    await prisma.purchaseProvisioningJob.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  });

  afterAll(async () => {
    await prisma.purchaseProvisioningJob.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    await prisma.$disconnect();
  });

  describe('enqueueProvisioningJobIfEligible', () => {
    it('agencyAccessMode!=noneの商品を含む注文はジョブを作成し、orders側もpendingにする', async () => {
      const product = await createAgencyProduct('agent_portal');
      const order = await createOrder({ productId: product.id });
      const orderItems = await prisma.orderItem.findMany({ where: { orderId: order.id } });

      await prisma.$transaction((tx) => enqueueProvisioningJobIfEligible(tx, order, orderItems));

      const job = await prisma.purchaseProvisioningJob.findUnique({ where: { deduplicationKey: `purchase-provisioning:${order.id}` } });
      expect(job).not.toBeNull();
      expect(job?.action).toBe('provision');
      const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updatedOrder.agencyProvisioningStatus).toBe('pending');
    });

    it('agencyAccessMode=noneの商品のみの注文はジョブを作成しない', async () => {
      const product = await createAgencyProduct('none');
      const order = await createOrder({ productId: product.id });
      const orderItems = await prisma.orderItem.findMany({ where: { orderId: order.id } });

      await prisma.$transaction((tx) => enqueueProvisioningJobIfEligible(tx, order, orderItems));

      const job = await prisma.purchaseProvisioningJob.findUnique({ where: { deduplicationKey: `purchase-provisioning:${order.id}` } });
      expect(job).toBeNull();
      const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updatedOrder.agencyProvisioningStatus).toBe('not_applicable');
    });

    it('重複enqueueしてもジョブは1件のまま(upsert)', async () => {
      const product = await createAgencyProduct('agent_portal');
      const order = await createOrder({ productId: product.id });
      const orderItems = await prisma.orderItem.findMany({ where: { orderId: order.id } });

      await prisma.$transaction((tx) => enqueueProvisioningJobIfEligible(tx, order, orderItems));
      await prisma.$transaction((tx) => enqueueProvisioningJobIfEligible(tx, order, orderItems));

      const count = await prisma.purchaseProvisioningJob.count({ where: { orderId: order.id, action: 'provision' } });
      expect(count).toBe(1);
    });
  });

  describe('enqueueProvisioningRevokeJobIfApplicable', () => {
    it('agencyProvisioningStatus=not_applicableの注文はrevokeジョブを作成しない', async () => {
      const product = await createAgencyProduct('none');
      const order = await createOrder({ productId: product.id, agencyProvisioningStatus: 'not_applicable' });

      await prisma.$transaction((tx) => enqueueProvisioningRevokeJobIfApplicable(tx, order));

      const job = await prisma.purchaseProvisioningJob.findUnique({ where: { deduplicationKey: `purchase-provisioning-revoke:${order.id}` } });
      expect(job).toBeNull();
    });

    it('agencyProvisioningStatus=provisionedの注文はrevokeジョブを作成する', async () => {
      const product = await createAgencyProduct('agent_portal');
      const order = await createOrder({ productId: product.id, commonUserId: 'cu_test_001', agencyProvisioningStatus: 'provisioned' });

      await prisma.$transaction((tx) => enqueueProvisioningRevokeJobIfApplicable(tx, order));

      const job = await prisma.purchaseProvisioningJob.findUnique({ where: { deduplicationKey: `purchase-provisioning-revoke:${order.id}` } });
      expect(job).not.toBeNull();
      expect(job?.action).toBe('revoke');
    });
  });

  describe('processPurchaseProvisioningJobs', () => {
    it('Feature Flag無効時はジョブをclaimせずpendingのまま残す', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const product = await createAgencyProduct('agent_portal');
      const order = await createOrder({ productId: product.id, commonUserId: 'cu_test_001' });
      const orderItems = await prisma.orderItem.findMany({ where: { orderId: order.id } });
      const job = await prisma.$transaction((tx) => enqueueProvisioningJobIfEligible(tx, order, orderItems).then(() =>
        tx.purchaseProvisioningJob.findUniqueOrThrow({ where: { deduplicationKey: `purchase-provisioning:${order.id}` } }),
      ));

      const result = await processPurchaseProvisioningJobs();

      expect(result).toEqual({ claimed: 0, succeeded: 0, retrying: 0, blocked: 0, dead: 0, skipped: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
      const after = await prisma.purchaseProvisioningJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(after.status).toBe('pending');
    });

    it('commonUserId未解決の注文はblocked(attempt_countを消費しない)になる', async () => {
      process.env.PURCHASE_PROVISIONING_ENABLED = 'true';
      await setSetting('purchase_provisioning_hmac_key_id', 'key-123');
      await setSetting('purchase_provisioning_hmac_secret', 'secret-abc');
      await setSetting('purchase_provisioning_base_url', 'https://agency-system.example.com');
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const product = await createAgencyProduct('agent_portal');
      const order = await createOrder({ productId: product.id, commonUserId: null });
      const orderItems = await prisma.orderItem.findMany({ where: { orderId: order.id } });
      await prisma.$transaction((tx) => enqueueProvisioningJobIfEligible(tx, order, orderItems));

      const result = await processPurchaseProvisioningJobs();

      expect(result.blocked).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
      const job = await prisma.purchaseProvisioningJob.findUniqueOrThrow({ where: { deduplicationKey: `purchase-provisioning:${order.id}` } });
      expect(job.status).toBe('blocked');
      expect(job.blockedReason).toBe('common_user_unresolved');
      expect(job.attemptCount).toBe(0);
    });

    it('正常応答でprovisionedになり、orders側へログインURL等が保存される', async () => {
      process.env.PURCHASE_PROVISIONING_ENABLED = 'true';
      await setSetting('purchase_provisioning_hmac_key_id', 'key-123');
      await setSetting('purchase_provisioning_hmac_secret', 'secret-abc');
      await setSetting('purchase_provisioning_base_url', 'https://agency-system.example.com');

      const product = await createAgencyProduct('agent_portal');
      const order = await createOrder({ productId: product.id, commonUserId: 'cu_test_001' });
      const orderItems = await prisma.orderItem.findMany({ where: { orderId: order.id } });
      await prisma.$transaction((tx) => enqueueProvisioningJobIfEligible(tx, order, orderItems));

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            common_user_id: 'cu_test_001',
            transaction: { transaction_id: 'txn_1' },
            account: { account_type: 'agent', account_id: 'agent_xxx', login_email: order.customerEmail, status: 'active' },
            access: { mode: 'sso', login_url: 'https://sengoku-ai.com/sso/consume?token=abc', expires_at: '2026-07-29T09:10:00Z' },
          }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await processPurchaseProvisioningJobs();

      expect(result.succeeded).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://agency-system.example.com/api/purchase-provisioning');
      expect(options.headers['Idempotency-Key']).toBe(`purchase-provisioning:${order.id}`);

      const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updatedOrder.agencyProvisioningStatus).toBe('provisioned');
      expect(updatedOrder.agencyAccountType).toBe('agent');
      expect(updatedOrder.agencyLoginUrl).toBe('https://sengoku-ai.com/sso/consume?token=abc');
    });

    it('common_user_idが一致しない応答は失敗として再試行される', async () => {
      process.env.PURCHASE_PROVISIONING_ENABLED = 'true';
      await setSetting('purchase_provisioning_hmac_key_id', 'key-123');
      await setSetting('purchase_provisioning_hmac_secret', 'secret-abc');
      await setSetting('purchase_provisioning_base_url', 'https://agency-system.example.com');

      const product = await createAgencyProduct('agent_portal');
      const order = await createOrder({ productId: product.id, commonUserId: 'cu_test_001' });
      const orderItems = await prisma.orderItem.findMany({ where: { orderId: order.id } });
      await prisma.$transaction((tx) => enqueueProvisioningJobIfEligible(tx, order, orderItems));

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ ok: true, common_user_id: 'cu_other_user', transaction: {} }),
        }),
      );

      const result = await processPurchaseProvisioningJobs();

      expect(result.retrying).toBe(1);
      const job = await prisma.purchaseProvisioningJob.findUniqueOrThrow({ where: { deduplicationKey: `purchase-provisioning:${order.id}` } });
      expect(job.status).toBe('pending');
      expect(job.attemptCount).toBe(1);
      expect(job.lastError).toContain('mismatch');
      const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      // provisionedへは進んでいない(誤ったユーザーへログイン権限を付与していない)。
      expect(updatedOrder.agencyProvisioningStatus).not.toBe('provisioned');
    });

    it('最大試行回数を超えるとdeadになり、orders側もfailedになる', async () => {
      process.env.PURCHASE_PROVISIONING_ENABLED = 'true';
      await setSetting('purchase_provisioning_hmac_key_id', 'key-123');
      await setSetting('purchase_provisioning_hmac_secret', 'secret-abc');
      await setSetting('purchase_provisioning_base_url', 'https://agency-system.example.com');

      const product = await createAgencyProduct('agent_portal');
      const order = await createOrder({ productId: product.id, commonUserId: 'cu_test_001' });
      const orderItems = await prisma.orderItem.findMany({ where: { orderId: order.id } });
      const job = await prisma.$transaction((tx) => enqueueProvisioningJobIfEligible(tx, order, orderItems).then(() =>
        tx.purchaseProvisioningJob.findUniqueOrThrow({ where: { deduplicationKey: `purchase-provisioning:${order.id}` } }),
      ));
      await prisma.purchaseProvisioningJob.update({ where: { id: job.id }, data: { attemptCount: 4 } });

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }));

      const result = await processPurchaseProvisioningJobs();

      expect(result.dead).toBe(1);
      const after = await prisma.purchaseProvisioningJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(after.status).toBe('dead');
      const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updatedOrder.agencyProvisioningStatus).toBe('failed');
    });

    it('revokeジョブ: commonUserIdが無ければno-opで成功扱いになる', async () => {
      process.env.PURCHASE_PROVISIONING_ENABLED = 'true';
      await setSetting('purchase_provisioning_hmac_key_id', 'key-123');
      await setSetting('purchase_provisioning_hmac_secret', 'secret-abc');
      await setSetting('purchase_provisioning_base_url', 'https://agency-system.example.com');
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const product = await createAgencyProduct('agent_portal');
      const order = await createOrder({ productId: product.id, commonUserId: null, agencyProvisioningStatus: 'pending' });
      await prisma.$transaction((tx) => enqueueProvisioningRevokeJobIfApplicable(tx, order));

      const result = await processPurchaseProvisioningJobs();

      expect(result.succeeded).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('revokeジョブ: 成功するとorders.agency_provisioning_statusがrevokedになる', async () => {
      process.env.PURCHASE_PROVISIONING_ENABLED = 'true';
      await setSetting('purchase_provisioning_hmac_key_id', 'key-123');
      await setSetting('purchase_provisioning_hmac_secret', 'secret-abc');
      await setSetting('purchase_provisioning_base_url', 'https://agency-system.example.com');

      const product = await createAgencyProduct('agent_portal');
      const order = await createOrder({ productId: product.id, commonUserId: 'cu_test_001', agencyProvisioningStatus: 'provisioned' });
      await prisma.$transaction((tx) => enqueueProvisioningRevokeJobIfApplicable(tx, order));

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) }));

      const result = await processPurchaseProvisioningJobs();

      expect(result.succeeded).toBe(1);
      const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updatedOrder.agencyProvisioningStatus).toBe('revoked');
    });
  });

  describe('retryPurchaseProvisioningJob / skipPurchaseProvisioningJob', () => {
    it('deadなジョブを手動retryして成功させられる', async () => {
      process.env.PURCHASE_PROVISIONING_ENABLED = 'true';
      await setSetting('purchase_provisioning_hmac_key_id', 'key-123');
      await setSetting('purchase_provisioning_hmac_secret', 'secret-abc');
      await setSetting('purchase_provisioning_base_url', 'https://agency-system.example.com');

      const product = await createAgencyProduct('agent_portal');
      const order = await createOrder({ productId: product.id, commonUserId: 'cu_test_001' });
      const orderItems = await prisma.orderItem.findMany({ where: { orderId: order.id } });
      const job = await prisma.$transaction((tx) => enqueueProvisioningJobIfEligible(tx, order, orderItems).then(() =>
        tx.purchaseProvisioningJob.findUniqueOrThrow({ where: { deduplicationKey: `purchase-provisioning:${order.id}` } }),
      ));
      await prisma.purchaseProvisioningJob.update({ where: { id: job.id }, data: { status: 'dead', attemptCount: 5 } });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ ok: true, common_user_id: 'cu_test_001', transaction: {}, access: { login_url: 'https://x/y' } }),
        }),
      );

      const result = await retryPurchaseProvisioningJob(job.id);
      expect(result).toEqual({ ok: true, status: 'succeeded' });
    });

    it('succeeded状態のジョブはskipできない', async () => {
      const product = await createAgencyProduct('agent_portal');
      const order = await createOrder({ productId: product.id, commonUserId: 'cu_test_001' });
      const orderItems = await prisma.orderItem.findMany({ where: { orderId: order.id } });
      const job = await prisma.$transaction((tx) => enqueueProvisioningJobIfEligible(tx, order, orderItems).then(() =>
        tx.purchaseProvisioningJob.findUniqueOrThrow({ where: { deduplicationKey: `purchase-provisioning:${order.id}` } }),
      ));
      await prisma.purchaseProvisioningJob.update({ where: { id: job.id }, data: { status: 'succeeded' } });

      const result = await skipPurchaseProvisioningJob(job.id);
      expect(result).toEqual({ ok: false });
    });

    it('pending状態のジョブはskipできる', async () => {
      const product = await createAgencyProduct('agent_portal');
      const order = await createOrder({ productId: product.id, commonUserId: 'cu_test_001' });
      const orderItems = await prisma.orderItem.findMany({ where: { orderId: order.id } });
      const job = await prisma.$transaction((tx) => enqueueProvisioningJobIfEligible(tx, order, orderItems).then(() =>
        tx.purchaseProvisioningJob.findUniqueOrThrow({ where: { deduplicationKey: `purchase-provisioning:${order.id}` } }),
      ));

      const result = await skipPurchaseProvisioningJob(job.id);
      expect(result).toEqual({ ok: true });
      const after = await prisma.purchaseProvisioningJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(after.status).toBe('skipped');
    });
  });

  describe('countPurchaseProvisioningBacklog', () => {
    it('pending・blockedの合計件数を返す', async () => {
      const product = await createAgencyProduct('agent_portal');
      const order = await createOrder({ productId: product.id, commonUserId: 'cu_test_001' });
      const orderItems = await prisma.orderItem.findMany({ where: { orderId: order.id } });
      await prisma.$transaction((tx) => enqueueProvisioningJobIfEligible(tx, order, orderItems));

      const backlog = await countPurchaseProvisioningBacklog();
      expect(backlog.total).toBeGreaterThanOrEqual(1);
      expect(backlog.total).toBe(backlog.pending + backlog.blocked);
    });
  });

  describe('reissueAgencyLoginUrl', () => {
    it('Feature Flag無効時はnot_configuredを返す', async () => {
      const product = await createAgencyProduct('agent_portal');
      const order = await createOrder({ productId: product.id, commonUserId: 'cu_test_001', agencyProvisioningStatus: 'provisioned' });

      const result = await reissueAgencyLoginUrl(order.id, order.userId ?? 'no-user');
      expect(result).toEqual({ ok: false, reason: 'not_configured' });
    });

    it('provisioned以外の注文はnot_eligibleを返す', async () => {
      process.env.PURCHASE_PROVISIONING_ENABLED = 'true';
      process.env.AGENCY_PORTAL_LOGIN_ENABLED = 'true';
      const product = await createAgencyProduct('agent_portal');
      const order = await createOrder({ productId: product.id, commonUserId: 'cu_test_001', agencyProvisioningStatus: 'pending' });

      const result = await reissueAgencyLoginUrl(order.id, 'someone-else');
      expect(result).toEqual({ ok: false, reason: 'not_eligible' });
    });

    it('provisioned済みの注文は新しいログインURLを取得して保存する', async () => {
      process.env.PURCHASE_PROVISIONING_ENABLED = 'true';
      process.env.AGENCY_PORTAL_LOGIN_ENABLED = 'true';
      await setSetting('purchase_provisioning_hmac_key_id', 'key-123');
      await setSetting('purchase_provisioning_hmac_secret', 'secret-abc');
      await setSetting('purchase_provisioning_base_url', 'https://agency-system.example.com');

      const bcrypt = await import('bcryptjs');
      const user = await prisma.user.create({
        data: { name: 'PPJユーザー', email: `${suffix}-reissue@example.com`, passwordHash: await bcrypt.hash('password123', 10) },
      });
      const product = await createAgencyProduct('agent_portal');
      const order = await prisma.order.create({
        data: {
          orderNumber: `SG-PPJTEST-REISSUE-${Date.now()}`,
          userId: user.id,
          totalAmount: 30000,
          originalAmount: 30000,
          paymentStatus: 'paid',
          orderStatus: 'paid',
          customerName: 'PPJテスト太郎',
          customerEmail: `${suffix}@example.com`,
          termsAgreedAt: new Date(),
          termsVersion: '2026-07-01',
          commonUserId: 'cu_test_001',
          agencyProvisioningStatus: 'provisioned',
          orderItems: {
            create: { productId: product.id, productName: 'テスト', itemType: 'membership', quantity: 1, unitPrice: 30000, subtotal: 30000 },
          },
        },
      });
      createdOrderIds.push(order.id);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              common_user_id: 'cu_test_001',
              transaction: {},
              access: { login_url: 'https://sengoku-ai.com/sso/consume?token=new', expires_at: '2026-08-01T00:00:00Z' },
            }),
        }),
      );

      const result = await reissueAgencyLoginUrl(order.id, user.id);
      expect(result).toEqual({ ok: true, loginUrl: 'https://sengoku-ai.com/sso/consume?token=new', loginUrlExpiresAt: '2026-08-01T00:00:00Z' });

      const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updatedOrder.agencyLoginUrl).toBe('https://sengoku-ai.com/sso/consume?token=new');

      await prisma.user.delete({ where: { id: user.id } });
    });
  });
});
