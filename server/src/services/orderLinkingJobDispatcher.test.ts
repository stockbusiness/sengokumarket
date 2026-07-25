import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { setSetting } from './settings';
import { enqueueCommonUserResolveJob, enqueueReferralCaptureJob, enqueueReferralConfirmPurchaseJob } from './orderLinkingJobs';
import {
  countOrderLinkingJobsBacklog,
  processOrderLinkingJobs,
  triggerImmediateOrderLinkingDispatch,
} from './orderLinkingJobDispatcher';

// 仕様書外の拡張(残課題指示書Stage4): common_user_id解決・referral captureを永続ジョブとして
// 処理するDispatcherの回帰テスト。Feature Flag無効時(既定)は既存フローに一切影響しないことを
// 重点的に確認する(最重要要件)。
describe('orderLinkingJobDispatcher(残課題指示書Stage4)', () => {
  const originalFlag = process.env.SENNOKUNI_INTEGRATION_ENABLED;
  const emailSuffix = `order-linking-job-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];

  async function createUser(commonUserId: string | null = null) {
    const user = await prisma.user.create({
      data: {
        name: 'ジョブテストユーザー',
        email: `${emailSuffix}-${Math.random().toString(36).slice(2)}@example.com`,
        passwordHash: await bcrypt.hash('password123', 10),
        commonUserId,
      },
    });
    createdUserIds.push(user.id);
    return user;
  }

  async function createOrder(opts: { userId?: string | null; referralCode?: string | null }) {
    const order = await prisma.order.create({
      data: {
        orderNumber: `SG-JOBTEST-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        userId: opts.userId ?? undefined,
        totalAmount: 10000,
        originalAmount: 10000,
        paymentStatus: 'paid',
        orderStatus: 'paid',
        customerName: 'ジョブテスト太郎',
        customerEmail: `${emailSuffix}@example.com`,
        termsAgreedAt: new Date(),
        termsVersion: '2026-07-01',
        referralCode: opts.referralCode ?? undefined,
      },
    });
    createdOrderIds.push(order.id);
    return order;
  }

  beforeAll(async () => {
    // 他のテストファイルが実際のcheckout/会員登録フローを通して残したorder_linking_jobs
    // (このStage4でjob_typeを問わず常時enqueueするようにしたため、統合連携と無関係な既存の
    // 決済・注文系テストも副次的にpending行を残す)を、本テストファイル開始前に掃除する。
    // vitest.config.tsのfileParallelism:falseによりテストファイルは直列実行されるため、
    // ここで一度掃除すれば本ファイルの実行中に新たな汚染が入り込むことはない。
    await prisma.orderLinkingJob.deleteMany({ where: { status: 'pending' } });
  });

  beforeEach(() => {
    delete process.env.SENNOKUNI_INTEGRATION_ENABLED;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.env.SENNOKUNI_INTEGRATION_ENABLED = originalFlag;
    await prisma.setting.deleteMany({
      where: { key: { in: ['sennokuni_hmac_key_id', 'sennokuni_hmac_secret', 'sennokuni_agency_hub_base_url'] } },
    });
    // 各テストが作成したジョブを都度片付け、他のテストのdispatch結果へ混入しないようにする。
    await prisma.orderLinkingJob.deleteMany({
      where: { OR: [{ userId: { in: createdUserIds } }, { orderId: { in: createdOrderIds } }] },
    });
  });

  afterAll(async () => {
    await prisma.orderLinkingJob.deleteMany({
      where: { OR: [{ userId: { in: createdUserIds } }, { orderId: { in: createdOrderIds } }] },
    });
    // 本番安定化指示書Stage9: common_user_resolveジョブがexternal_identitiesへ書き込むため、
    // users削除前にFK制約を満たすよう先に削除する。
    await prisma.externalIdentity.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  it('Feature Flag無効時はジョブをclaimせずpendingのまま残す(既存フローへの影響なし)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const user = await createUser();
    const job = await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));

    const result = await processOrderLinkingJobs();

    expect(result).toEqual({ claimed: 0, succeeded: 0, retrying: 0, blocked: 0, dead: 0, skipped: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    const after = await prisma.orderLinkingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('pending');
  });

  it('Feature Flag再度有効化後は溜まったpendingジョブを処理できる', async () => {
    const user = await createUser();
    await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));

    // 無効時にディスパッチしても何も起きないことを確認してから、有効化する。
    await processOrderLinkingJobs();

    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ common_user_id: `cu_${emailSuffix}_reactivated` }) }),
    );

    const result = await processOrderLinkingJobs();
    expect(result.succeeded).toBe(1);

    const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updatedUser.commonUserId).toBe(`cu_${emailSuffix}_reactivated`);
  });

  // 本番安定化指示書Stage2・5.4「1回の処理時間上限」: Functionの残り時間に余裕がない場合は
  // 新規claimを停止する(integration_outbox_eventsと同じ方針)。
  it('時間予算(ORDER_LINKING_TIME_BUDGET_MS)を使い切っている場合は新規claimを行わない', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    process.env.ORDER_LINKING_TIME_BUDGET_MS = '0';
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const user = await createUser();
    const job = await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));

    const result = await processOrderLinkingJobs();

    expect(result.claimed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const after = await prisma.orderLinkingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('pending');

    delete process.env.ORDER_LINKING_TIME_BUDGET_MS;
  });

  describe('common_user_resolve job', () => {
    it('未解決ユーザーはresolve APIを呼びcommonUserIdを更新する(orderIdがあれば注文へも反映)', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_hmac_key_id', 'key-123');
      await setSetting('sennokuni_hmac_secret', 'secret-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

      const user = await createUser();
      const order = await createOrder({ userId: user.id });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ common_user_id: `cu_${emailSuffix}_resolved_1` }) }),
      );
      await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id, orderId: order.id }));

      const result = await processOrderLinkingJobs();
      expect(result).toMatchObject({ claimed: 1, succeeded: 1, retrying: 0, dead: 0 });

      const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(updatedUser.commonUserId).toBe(`cu_${emailSuffix}_resolved_1`);
      const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updatedOrder.commonUserId).toBe(`cu_${emailSuffix}_resolved_1`);
      expect(updatedOrder.commonUserResolutionStatus).toBe('resolved');
    });

    it('既にcommonUserId解決済みのユーザーはAPIを呼ばずorderへ反映するのみ(即succeeded)', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_hmac_key_id', 'key-123');
      await setSetting('sennokuni_hmac_secret', 'secret-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

      const user = await createUser(`cu_${emailSuffix}_already_resolved`);
      const order = await createOrder({ userId: user.id });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id, orderId: order.id }));

      const result = await processOrderLinkingJobs();
      expect(result.succeeded).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();

      const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updatedOrder.commonUserId).toBe(`cu_${emailSuffix}_already_resolved`);
      expect(updatedOrder.commonUserResolutionStatus).toBe('resolved');
    });

    it('外部API停止時(非2xx)はpendingへ戻りbackoffが設定され、再試行可能', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_hmac_key_id', 'key-123');
      await setSetting('sennokuni_hmac_secret', 'secret-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

      const user = await createUser();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve({}) }));
      const job = await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));

      const result = await processOrderLinkingJobs();
      expect(result.retrying).toBe(1);

      const after = await prisma.orderLinkingJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(after.status).toBe('pending');
      expect(after.attemptCount).toBe(1);
      expect(after.nextAttemptAt).not.toBeNull();
      expect(after.lastError).toBeTruthy();
    });

    it('最大試行回数を超えるとdeadになる', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_hmac_key_id', 'key-123');
      await setSetting('sennokuni_hmac_secret', 'secret-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

      const user = await createUser();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
      const job = await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));
      await prisma.orderLinkingJob.update({ where: { id: job.id }, data: { attemptCount: 4 } });

      const result = await processOrderLinkingJobs();
      expect(result.dead).toBe(1);
      const after = await prisma.orderLinkingJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(after.status).toBe('dead');
    });

    // 本番安定化指示書Stage9(12.1「ExternalIdentity」)。
    it('解決成功時、users.commonUserIdだけでなくexternal_identitiesへも保存する', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_hmac_key_id', 'key-123');
      await setSetting('sennokuni_hmac_secret', 'secret-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

      const user = await createUser();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ common_user_id: `cu_${emailSuffix}_identity_1` }) }),
      );
      await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));

      const result = await processOrderLinkingJobs();
      expect(result.succeeded).toBe(1);

      const identity = await prisma.externalIdentity.findUniqueOrThrow({
        where: { systemKey_externalUserId: { systemKey: 'sengoku-market', externalUserId: user.id } },
      });
      expect(identity.userId).toBe(user.id);
      expect(identity.commonUserId).toBe(`cu_${emailSuffix}_identity_1`);
      expect(identity.identityType).toBe('email');
      expect(identity.verifiedAt).not.toBeNull();
    });

    // 本番安定化指示書Stage9(12.2「common user merge」・12.4「異なるcommon IDで自動上書き
    // しない・conflict管理可能」)。
    it('既存external_identitiesと異なるcommon_user_idが返るとconflictでblockedになり、上書きしない', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_hmac_key_id', 'key-123');
      await setSetting('sennokuni_hmac_secret', 'secret-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

      const user = await createUser();
      await prisma.externalIdentity.create({
        data: {
          userId: user.id,
          systemKey: 'sengoku-market',
          externalUserId: user.id,
          commonUserId: `cu_${emailSuffix}_original`,
          identityType: 'email',
          verifiedAt: new Date(),
        },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ common_user_id: `cu_${emailSuffix}_conflicting` }) }),
      );
      const job = await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));

      const result = await processOrderLinkingJobs();
      expect(result.blocked).toBe(1);

      const after = await prisma.orderLinkingJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(after.status).toBe('blocked');
      expect(after.blockedReason).toBe('common_user_id_conflict');
      expect(after.attemptCount).toBe(0);
      expect(after.lastError).toContain(`cu_${emailSuffix}_original`);
      expect(after.lastError).toContain(`cu_${emailSuffix}_conflicting`);

      // 上書きされていないこと。
      const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(updatedUser.commonUserId).toBeNull();
      const identity = await prisma.externalIdentity.findUniqueOrThrow({
        where: { systemKey_externalUserId: { systemKey: 'sengoku-market', externalUserId: user.id } },
      });
      expect(identity.commonUserId).toBe(`cu_${emailSuffix}_original`);
    });

    it('conflictでblockedになったジョブは自動再評価の対象外になり、外部APIを再び呼ばない', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_hmac_key_id', 'key-123');
      await setSetting('sennokuni_hmac_secret', 'secret-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

      const user = await createUser();
      await prisma.externalIdentity.create({
        data: {
          userId: user.id,
          systemKey: 'sengoku-market',
          externalUserId: user.id,
          commonUserId: `cu_${emailSuffix}_stay_original`,
          identityType: 'email',
          verifiedAt: new Date(),
        },
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: true, json: () => Promise.resolve({ common_user_id: `cu_${emailSuffix}_stay_conflicting` }) });
      vi.stubGlobal('fetch', fetchMock);
      await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));

      const firstResult = await processOrderLinkingJobs();
      expect(firstResult.blocked).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // 2回目のdispatchでは自動的に再claimされない(外部APIも再度呼ばれない)。
      const secondResult = await processOrderLinkingJobs();
      expect(secondResult.claimed).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('referral_capture job', () => {
    it('referralCodeがある注文はcapture APIを呼びreferralSessionKeyを保存する', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_hmac_key_id', 'key-123');
      await setSetting('sennokuni_hmac_secret', 'secret-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

      const order = await createOrder({ referralCode: 'SGI0099' });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              status: 'captured',
              canonical_referral_token: 'rt_test',
              referral_session_key: 'rs_test_job',
              agency_id: 'AGENT-CODE-JOB',
              expires_at: null,
            }),
        }),
      );
      await prisma.$transaction((tx) => enqueueReferralCaptureJob(tx, order.id));

      const result = await processOrderLinkingJobs();
      expect(result.succeeded).toBe(1);

      const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updatedOrder.referralSessionKey).toBe('rs_test_job');
      // referral confirmはStage5で別途enqueueするため、この時点では代理店4役は確定しない。
      expect(updatedOrder.registrationReferrerAgentCode).toBeNull();
    });

    it('captureが失敗した場合は再試行できる', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_hmac_key_id', 'key-123');
      await setSetting('sennokuni_hmac_secret', 'secret-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

      const order = await createOrder({ referralCode: 'SGI0098' });
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
      const job = await prisma.$transaction((tx) => enqueueReferralCaptureJob(tx, order.id));

      const result = await processOrderLinkingJobs();
      expect(result.retrying).toBe(1);
      const after = await prisma.orderLinkingJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(after.status).toBe('pending');
    });
  });

  describe('referral_confirm_purchase job(残課題指示書Stage5)', () => {
    it('referralSessionKey・commonUserIdが揃っていればconfirm APIを呼び代理店4役を保存する', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_hmac_key_id', 'key-123');
      await setSetting('sennokuni_hmac_secret', 'secret-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

      const order = await createOrder({ referralCode: 'SGI0097' });
      await prisma.order.update({
        where: { id: order.id },
        data: { referralSessionKey: 'rs_confirm_test', commonUserId: `cu_${emailSuffix}_confirm_purchase` },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              status: 'confirmed',
              common_user_id: `cu_${emailSuffix}_confirm_purchase`,
              registration_referrer_agency_id: 'AGENT-CODE-001',
              assigned_agency_id: 'AGENT-CODE-002',
              sales_agent_id: 'AGENT-CODE-003',
              closing_agent_id: 'AGENT-CODE-004',
            }),
        }),
      );
      await prisma.$transaction((tx) => enqueueReferralConfirmPurchaseJob(tx, order.id));

      const result = await processOrderLinkingJobs();
      expect(result.succeeded).toBe(1);

      const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updatedOrder.registrationReferrerAgentCode).toBe('AGENT-CODE-001');
      expect(updatedOrder.assignedAgentCode).toBe('AGENT-CODE-002');
      expect(updatedOrder.salesAgentCode).toBe('AGENT-CODE-003');
      expect(updatedOrder.closingAgentCode).toBe('AGENT-CODE-004');
    });

    // 本番安定化指示書Stage9(12.3「confirm結果検証」)。
    it('confirmレスポンスのcommon_user_idが送信値と一致しない場合は成功扱いにせず再試行になる', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_hmac_key_id', 'key-123');
      await setSetting('sennokuni_hmac_secret', 'secret-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

      const order = await createOrder({ referralCode: 'SGI0097-mismatch' });
      await prisma.order.update({
        where: { id: order.id },
        data: { referralSessionKey: 'rs_confirm_mismatch', commonUserId: `cu_${emailSuffix}_sent` },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              status: 'confirmed',
              common_user_id: `cu_${emailSuffix}_different_from_sent`,
              registration_referrer_agency_id: 'AGENT-CODE-001',
              assigned_agency_id: 'AGENT-CODE-002',
              sales_agent_id: 'AGENT-CODE-003',
              closing_agent_id: 'AGENT-CODE-004',
            }),
        }),
      );
      const job = await prisma.$transaction((tx) => enqueueReferralConfirmPurchaseJob(tx, order.id));

      const result = await processOrderLinkingJobs();
      expect(result.retrying).toBe(1);
      expect(result.succeeded).toBe(0);

      const after = await prisma.orderLinkingJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(after.status).toBe('pending');
      expect(after.lastError).toContain('mismatch');

      // 代理店4役は保存されない(成功扱いにしない)。
      const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updatedOrder.registrationReferrerAgentCode).toBeNull();
    });

    // 本番安定化指示書Stage5(8.3): 依存待ち(referral_session_unresolved/common_user_unresolved)
    // はretrying/failedではなくblockedへ遷移し、attempt_countを消費しない(8.7「依存待ちで
    // deadにならない」の直接検証)。
    it('referralSessionKeyが未解決(referral_captureが未完了)の間はblockedになりattempt_countを消費しない', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_hmac_key_id', 'key-123');
      await setSetting('sennokuni_hmac_secret', 'secret-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

      const order = await createOrder({ referralCode: 'SGI0096' });
      await prisma.order.update({ where: { id: order.id }, data: { commonUserId: `cu_${emailSuffix}_pending_session` } });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const job = await prisma.$transaction((tx) => enqueueReferralConfirmPurchaseJob(tx, order.id));

      const result = await processOrderLinkingJobs();
      expect(result.blocked).toBe(1);
      expect(result.retrying).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
      const after = await prisma.orderLinkingJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(after.status).toBe('blocked');
      expect(after.blockedReason).toBe('referral_session_unresolved');
      expect(after.attemptCount).toBe(0);
    });

    it('commonUserIdが未解決(common_user_resolveが未完了)の間はblockedになりattempt_countを消費しない', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_hmac_key_id', 'key-123');
      await setSetting('sennokuni_hmac_secret', 'secret-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

      const order = await createOrder({ referralCode: 'SGI0095' });
      await prisma.order.update({ where: { id: order.id }, data: { referralSessionKey: 'rs_no_common_user' } });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const job = await prisma.$transaction((tx) => enqueueReferralConfirmPurchaseJob(tx, order.id));

      const result = await processOrderLinkingJobs();
      expect(result.blocked).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
      const after = await prisma.orderLinkingJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(after.status).toBe('blocked');
      expect(after.blockedReason).toBe('common_user_unresolved');
      expect(after.attemptCount).toBe(0);
    });

    it('blockedになったジョブは依存解決後の再ディスパッチで自動的に処理される(依存解決後にpendingへ戻る運用の実質)', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_hmac_key_id', 'key-123');
      await setSetting('sennokuni_hmac_secret', 'secret-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

      const order = await createOrder({ referralCode: 'SGI0093' });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const job = await prisma.$transaction((tx) => enqueueReferralConfirmPurchaseJob(tx, order.id));

      const blockedResult = await processOrderLinkingJobs();
      expect(blockedResult.blocked).toBe(1);
      const blocked = await prisma.orderLinkingJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(blocked.status).toBe('blocked');

      // 依存(referral capture・common_user_resolve)が解決したことを模す。
      await prisma.order.update({
        where: { id: order.id },
        data: { referralSessionKey: 'rs_now_ready', commonUserId: `cu_${emailSuffix}_now_ready` },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              status: 'confirmed',
              common_user_id: `cu_${emailSuffix}_now_ready`,
              registration_referrer_agency_id: null,
              assigned_agency_id: null,
              sales_agent_id: null,
              closing_agent_id: null,
            }),
        }),
      );

      const secondResult = await processOrderLinkingJobs();
      expect(secondResult.succeeded).toBe(1);
      const after = await prisma.orderLinkingJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(after.status).toBe('succeeded');
    });

    it('referralCodeが無い注文はconfirm APIを呼ばず即成功する', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_hmac_key_id', 'key-123');
      await setSetting('sennokuni_hmac_secret', 'secret-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

      const order = await createOrder({ referralCode: null });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await prisma.$transaction((tx) => enqueueReferralConfirmPurchaseJob(tx, order.id));

      const result = await processOrderLinkingJobs();
      expect(result.succeeded).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('confirmが失敗した場合は再試行できる', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_hmac_key_id', 'key-123');
      await setSetting('sennokuni_hmac_secret', 'secret-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

      const order = await createOrder({ referralCode: 'SGI0094' });
      await prisma.order.update({
        where: { id: order.id },
        data: { referralSessionKey: 'rs_confirm_fail', commonUserId: `cu_${emailSuffix}_confirm_fail` },
      });
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
      const job = await prisma.$transaction((tx) => enqueueReferralConfirmPurchaseJob(tx, order.id));

      const result = await processOrderLinkingJobs();
      expect(result.retrying).toBe(1);
      const after = await prisma.orderLinkingJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(after.status).toBe('pending');
    });
  });

  // 本番安定化指示書Stage5(8.1・8.7「同一user/orderの重複jobなし」): enqueueはcreateではなく
  // upsert(重複時no-op)を使うため、同じuser/orderに対して複数回enqueueしても行が増えない。
  describe('deduplication_key(本番安定化指示書Stage5・8.1)', () => {
    it('同一userIdのcommon_user_resolveジョブを複数回enqueueしても1行しか作られない', async () => {
      const user = await createUser();
      const first = await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));
      const second = await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));

      expect(second.id).toBe(first.id);
      const count = await prisma.orderLinkingJob.count({ where: { deduplicationKey: `common-user-resolve:${user.id}` } });
      expect(count).toBe(1);
    });

    it('同一orderIdのreferral_captureジョブを複数回enqueueしても1行しか作られない', async () => {
      const order = await createOrder({ referralCode: 'SGI0092' });
      const first = await prisma.$transaction((tx) => enqueueReferralCaptureJob(tx, order.id));
      const second = await prisma.$transaction((tx) => enqueueReferralCaptureJob(tx, order.id));

      expect(second.id).toBe(first.id);
      const count = await prisma.orderLinkingJob.count({ where: { deduplicationKey: `referral-capture:${order.id}` } });
      expect(count).toBe(1);
    });

    it('同一orderIdのreferral_confirm_purchaseジョブを複数回enqueueしても1行しか作られない', async () => {
      const order = await createOrder({ referralCode: 'SGI0091' });
      const first = await prisma.$transaction((tx) => enqueueReferralConfirmPurchaseJob(tx, order.id));
      const second = await prisma.$transaction((tx) => enqueueReferralConfirmPurchaseJob(tx, order.id));

      expect(second.id).toBe(first.id);
      const count = await prisma.orderLinkingJob.count({ where: { deduplicationKey: `referral-confirm-purchase:${order.id}` } });
      expect(count).toBe(1);
    });
  });

  // 本番安定化指示書Stage5(8.4): depends_on_job_idの代わりにjob_type優先順位でDispatcherが
  // 処理することの検証。同一バッチ内でcommon_user_resolveが先に解決されることで、
  // referral_confirm_purchaseが同じバッチで成功できる。
  it('job_type優先順位: common_user_resolveがreferral_confirm_purchaseより先に同一バッチ内で処理される', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

    const user = await createUser();
    const order = await createOrder({ userId: user.id, referralCode: 'SGI0090' });
    await prisma.order.update({ where: { id: order.id }, data: { referralSessionKey: 'rs_priority_test' } });

    // referral_confirm_purchaseを先にenqueueしても、優先順位はjob_typeで決まるため
    // common_user_resolveが同一バッチ内で先に処理される。
    await prisma.$transaction((tx) => enqueueReferralConfirmPurchaseJob(tx, order.id));
    await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id, orderId: order.id }));

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/common-users/resolve')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ common_user_id: `cu_${emailSuffix}_priority` }) });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            status: 'confirmed',
            common_user_id: `cu_${emailSuffix}_priority`,
            registration_referrer_agency_id: null,
            assigned_agency_id: null,
            sales_agent_id: null,
            closing_agent_id: null,
          }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await processOrderLinkingJobs();
    // 同一バッチ内でcommon_user_resolveが先に解決されるため、referral_confirm_purchaseも
    // blockedにならずこのバッチで成功する。
    expect(result.succeeded).toBe(2);
    expect(result.blocked).toBe(0);
  });

  // 本番安定化指示書Stage5(8.5・方針A「activation時batch制限」)。
  it('ORDER_LINKING_BATCH_LIMITで1回あたりのclaim件数を制限できる', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    process.env.ORDER_LINKING_BATCH_LIMIT = '1';
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

    const userA = await createUser();
    const userB = await createUser();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ common_user_id: `cu_${emailSuffix}_batchlimit` }) }));
    await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: userA.id }));
    await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: userB.id }));

    const result = await processOrderLinkingJobs();
    expect(result.claimed).toBe(1);

    delete process.env.ORDER_LINKING_BATCH_LIMIT;
  });

  // 本番安定化指示書Stage5(8.6「backlog件数表示」)。
  it('countOrderLinkingJobsBacklogはpending・blockedの件数を返す', async () => {
    const user = await createUser();
    const order = await createOrder({ referralCode: 'SGI0089' });
    await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));
    await prisma.orderLinkingJob.create({
      data: { jobType: 'referral_confirm_purchase', orderId: order.id, status: 'blocked', blockedReason: 'referral_session_unresolved' },
    });

    const backlog = await countOrderLinkingJobsBacklog();
    expect(backlog.pending).toBeGreaterThanOrEqual(1);
    expect(backlog.blocked).toBeGreaterThanOrEqual(1);
    expect(backlog.total).toBe(backlog.pending + backlog.blocked);
  });

  it('二重処理防止: 同時に複数回claimしても1件のジョブは1回しか処理されない', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

    const user = await createUser();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ common_user_id: `cu_${emailSuffix}_concurrent` }) });
    vi.stubGlobal('fetch', fetchMock);
    await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));

    const [resultA, resultB] = await Promise.all([processOrderLinkingJobs(), processOrderLinkingJobs()]);
    expect(resultA.claimed + resultB.claimed).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('triggerImmediateOrderLinkingDispatchは例外を投げない(呼び出し元を巻き込まない)', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));

    const user = await createUser();
    await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));

    await expect(triggerImmediateOrderLinkingDispatch()).resolves.toBeUndefined();
  });
});
