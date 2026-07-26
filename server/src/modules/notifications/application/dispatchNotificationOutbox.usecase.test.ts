import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { setSetting } from '../../../services/settings';
import { hashClaimToken } from '../../../services/walletClaim';
import * as repo from '../infrastructure/notificationOutbox.repository';
import { dispatchPendingNotifications, retryNotification } from './dispatchNotificationOutbox.usecase';

const sendViaResendOrThrow = vi.fn(async (_message: unknown) => undefined);

vi.mock('../infrastructure/resend.adapter', () => ({
  sendViaResendOrThrow: (message: unknown) => sendViaResendOrThrow(message),
  sendViaResend: vi.fn(async () => undefined),
}));

// 残課題指示書Stage3・テスト要件(15章): DB commit後メール失敗・token作成失敗・再送・二重送信防止。
describe('dispatchPendingNotifications(残課題指示書Stage3)', () => {
  let userId: string;
  const emailSuffix = `dispatch-notification-outbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  beforeEach(() => {
    sendViaResendOrThrow.mockReset();
    sendViaResendOrThrow.mockImplementation(async () => undefined);
  });

  afterAll(async () => {
    await prisma.notificationOutboxEvent.deleteMany({ where: { recipient: { contains: emailSuffix } } });
    await prisma.passwordResetToken.deleteMany({ where: { user: { email: { contains: emailSuffix } } } });
    await prisma.user.deleteMany({ where: { email: { contains: emailSuffix } } });
    await prisma.$disconnect();
  });

  async function createUser() {
    const email = `${emailSuffix}-${Math.random().toString(36).slice(2)}@example.com`;
    const user = await prisma.user.create({
      data: { name: '通知テストユーザー', email, passwordHash: 'x' },
    });
    return user;
  }

  it('DB commit後にメール送信が失敗した場合、pendingへ戻りbackoffが設定される(dead化はしない)', async () => {
    const user = await createUser();
    const event = await repo.enqueueNotification(prisma, {
      eventType: 'agency_access_granted',
      recipient: user.email,
      payload: { name: user.name },
    });

    // フルスイート実行時は他テストが積んだpendingイベントがBATCH_LIMIT内に混在しうるため、
    // 「最初の1回」ではなく「このテストの送信先宛てのみ」失敗させることで、この注文分のイベントの
    // 挙動だけを厳密に検証する(他の無関係なイベントは正常送信されても構わない)。
    sendViaResendOrThrow.mockImplementation(async (message: unknown) => {
      if ((message as { to?: string }).to === user.email) throw new Error('resend api error');
    });

    await dispatchPendingNotifications();

    const updated = await prisma.notificationOutboxEvent.findUnique({ where: { id: event.id } });
    expect(updated?.status).toBe('pending');
    expect(updated?.attemptCount).toBe(1);
    expect(updated?.lastError).toContain('resend api error');
    expect(updated?.nextAttemptAt).not.toBeNull();
    expect(updated!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
  });

  // 本番安定化指示書Stage2・5.4「1回の処理時間上限」: Functionの残り時間に余裕がない場合は
  // 新規claimを停止する(integration_outbox_eventsと同じ方針)。
  it('時間予算(NOTIFICATION_OUTBOX_TIME_BUDGET_MS)を使い切っている場合は新規claimを行わない', async () => {
    process.env.NOTIFICATION_OUTBOX_TIME_BUDGET_MS = '0';
    const user = await createUser();
    const event = await repo.enqueueNotification(prisma, {
      eventType: 'agency_access_granted',
      recipient: user.email,
      payload: { name: user.name },
    });

    try {
      const result = await dispatchPendingNotifications();
      expect(result.claimed).toBe(0);
      expect(sendViaResendOrThrow).not.toHaveBeenCalled();

      const updated = await prisma.notificationOutboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(updated.status).toBe('pending');
    } finally {
      delete process.env.NOTIFICATION_OUTBOX_TIME_BUDGET_MS;
    }
  });

  it('最大試行回数を超えるとdeadになる', async () => {
    const user = await createUser();
    const event = await repo.enqueueNotification(prisma, {
      eventType: 'agency_access_granted',
      recipient: user.email,
      payload: { name: user.name },
    });
    // 既に4回失敗済みの状態を再現する(次の失敗で5回目=上限)。
    await prisma.notificationOutboxEvent.update({ where: { id: event.id }, data: { attemptCount: 4 } });

    // フルスイート実行時に他テストのpendingイベントが同一バッチに混在しても正常送信できるよう、
    // このテストの送信先宛てのみ失敗させる。
    sendViaResendOrThrow.mockImplementation(async (message: unknown) => {
      if ((message as { to?: string }).to === user.email) throw new Error('resend api error');
    });

    await dispatchPendingNotifications();

    const updated = await prisma.notificationOutboxEvent.findUnique({ where: { id: event.id } });
    expect(updated?.status).toBe('dead');
  });

  it('token作成(パスワード再設定トークン発行)に失敗した場合もpendingへ戻り再試行される', async () => {
    const user = await createUser();
    const event = await repo.enqueueNotification(prisma, {
      eventType: 'agency_account_setup',
      recipient: user.email,
      payload: { name: user.name, userId: user.id },
    });

    // ユーザーを削除し、トークン発行(passwordResetToken.create)がFK制約で失敗する状況を再現する。
    await prisma.user.delete({ where: { id: user.id } });

    const result = await dispatchPendingNotifications();
    expect(result.retrying + result.dead).toBe(1);
    expect(sendViaResendOrThrow).not.toHaveBeenCalled();

    const updated = await prisma.notificationOutboxEvent.findUnique({ where: { id: event.id } });
    expect(updated?.status === 'pending' || updated?.status === 'dead').toBe(true);
    expect(updated?.lastError).toBeTruthy();
  });

  it('failed状態のイベントをretryNotificationで手動再送できる', async () => {
    const user = await createUser();
    const event = await repo.enqueueNotification(prisma, {
      eventType: 'agency_access_granted',
      recipient: user.email,
      payload: { name: user.name },
    });
    await prisma.notificationOutboxEvent.update({ where: { id: event.id }, data: { status: 'failed' } });

    const result = await retryNotification(event.id);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('succeeded');
    expect(sendViaResendOrThrow).toHaveBeenCalledTimes(1);
  });

  it('存在しない・再送不可なイベントIDはok:falseを返す', async () => {
    const result = await retryNotification('00000000-0000-0000-0000-000000000000');
    expect(result.ok).toBe(false);
  });

  it('二重送信防止: 同時に複数のDispatcherが同一batchをclaimしても、1件のイベントは1回しか処理されない', async () => {
    const user = await createUser();
    await repo.enqueueNotification(prisma, {
      eventType: 'agency_access_granted',
      recipient: user.email,
      payload: { name: user.name },
    });

    const [resultA, resultB] = await Promise.all([dispatchPendingNotifications(), dispatchPendingNotifications()]);
    // pending行はDB側の条件付きUPDATE(WHERE status='pending')で1回しかclaimされないため、
    // 2回の呼び出し合計でも claimed は1のはず(同時実行下の二重取得がないことの確認)。
    expect(resultA.claimed + resultB.claimed).toBe(1);
    expect(sendViaResendOrThrow).toHaveBeenCalledTimes(1);
  });
});

// Wallet Claim本番前安定化指示書(2026-07-25)Phase1・Phase11: 管理者再発行のwallet_claim_reissued
// イベント。実際のToken発行自体をDispatcher実行時に行うため(生Token・生URLをpayloadへ保存しない)、
// ここで発行・送信・失敗時の挙動を検証する。
describe('dispatchPendingNotifications: wallet_claim_reissued(Wallet Claim本番前安定化指示書Phase1)', () => {
  const ORDER_PREFIX = 'SG-NOTIFWCTEST-';

  beforeEach(() => {
    sendViaResendOrThrow.mockReset();
    sendViaResendOrThrow.mockImplementation(async () => undefined);
  });

  afterEach(async () => {
    await prisma.notificationOutboxEvent.deleteMany({ where: { recipient: { contains: 'notif-wc-test-' } } });
    await prisma.walletClaim.deleteMany({ where: { order: { orderNumber: { startsWith: ORDER_PREFIX } } } });
    await prisma.order.deleteMany({ where: { orderNumber: { startsWith: ORDER_PREFIX } } });
    await prisma.setting.deleteMany({ where: { key: 'wallet_claim_web_base_url' } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createOrderWithClaim(suffix: string, status = 'PENDING') {
    const order = await prisma.order.create({
      data: {
        orderNumber: `${ORDER_PREFIX}${suffix}`,
        totalAmount: 10000,
        originalAmount: 10000,
        paymentStatus: 'paid',
        orderStatus: 'paid',
        customerName: '通知テスト太郎',
        customerEmail: `notif-wc-test-${suffix}@example.com`,
        termsAgreedAt: new Date(),
        termsVersion: '2026-07-01',
      },
    });
    const claim = await prisma.walletClaim.create({
      data: { orderId: order.id, tokenHash: hashClaimToken(`old-token-${suffix}`), status, expiresAt: new Date(Date.now() + 1000 * 60 * 60) },
    });
    return { order, claim };
  }

  it('URL設定済みの場合、Dispatcher実行時にTokenを発行してメール送信し、succeededになる', async () => {
    await setSetting('wallet_claim_web_base_url', 'https://wallet.example.com');
    const { order, claim } = await createOrderWithClaim('ok');
    await repo.enqueueNotification(prisma, {
      eventType: 'wallet_claim_reissued',
      recipient: order.customerEmail,
      payload: { orderId: order.id },
    });

    const result = await dispatchPendingNotifications();
    expect(result.succeeded).toBe(1);
    expect(sendViaResendOrThrow).toHaveBeenCalledTimes(1);
    const sentMessage = sendViaResendOrThrow.mock.calls[0][0] as { html: string; text: string };
    expect(sentMessage.html).toContain('https://wallet.example.com/claim/');

    const updatedClaim = await prisma.walletClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(updatedClaim.tokenHash).not.toBe(hashClaimToken('old-token-ok'));
    expect(updatedClaim.reissueCount).toBe(1);
  });

  it('wallet_claim_web_base_url未設定の場合、Tokenを書き換えずにretryへ回る(送信も試みない)', async () => {
    const { order, claim } = await createOrderWithClaim('nourl');
    await repo.enqueueNotification(prisma, {
      eventType: 'wallet_claim_reissued',
      recipient: order.customerEmail,
      payload: { orderId: order.id },
    });

    const result = await dispatchPendingNotifications();
    expect(result.retrying).toBe(1);
    expect(sendViaResendOrThrow).not.toHaveBeenCalled();

    const updatedClaim = await prisma.walletClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(updatedClaim.tokenHash).toBe(hashClaimToken('old-token-nourl')); // 変更されない
    expect(updatedClaim.reissueCount).toBe(0);
  });

  it('メール送信(Resend)が失敗した場合はretryへ回り、次回成功時に最新Tokenが送信される', async () => {
    await setSetting('wallet_claim_web_base_url', 'https://wallet.example.com');
    const { order, claim } = await createOrderWithClaim('resendfail');
    await repo.enqueueNotification(prisma, {
      eventType: 'wallet_claim_reissued',
      recipient: order.customerEmail,
      payload: { orderId: order.id },
    });

    sendViaResendOrThrow.mockImplementationOnce(async () => {
      throw new Error('resend 5xx');
    });
    const firstResult = await dispatchPendingNotifications();
    expect(firstResult.retrying).toBe(1);
    const afterFirstFailure = await prisma.walletClaim.findUniqueOrThrow({ where: { id: claim.id } });
    // 送信失敗時点でToken自体は既に発行済み(この時点のTokenは配送されていない)。
    expect(afterFirstFailure.reissueCount).toBe(1);

    // backoff(5分後)を待たずに次回試行させる(テスト用にnext_attempt_atを過去へ戻す)。
    await prisma.notificationOutboxEvent.updateMany({
      where: { recipient: order.customerEmail },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });

    const secondResult = await dispatchPendingNotifications();
    expect(secondResult.succeeded).toBe(1);
    const afterSecondSuccess = await prisma.walletClaim.findUniqueOrThrow({ where: { id: claim.id } });
    // 再試行のたびに新しいTokenが発行されるため、実際に送信されたのは最新のTokenと一致する。
    expect(afterSecondSuccess.reissueCount).toBe(2);
    expect(afterSecondSuccess.tokenHash).not.toBe(afterFirstFailure.tokenHash);
  });

  it('CLAIMED以降・REVOKED等の再発行不可な状態はエラーとしてretryへ回る', async () => {
    await setSetting('wallet_claim_web_base_url', 'https://wallet.example.com');
    const { order } = await createOrderWithClaim('notreissuable', 'DELIVERY_PENDING');
    await repo.enqueueNotification(prisma, {
      eventType: 'wallet_claim_reissued',
      recipient: order.customerEmail,
      payload: { orderId: order.id },
    });

    const result = await dispatchPendingNotifications();
    expect(result.retrying).toBe(1);
    expect(sendViaResendOrThrow).not.toHaveBeenCalled();
  });

  // 最終安定化指示書Phase2「Notification Tokenの安定化」: NOTIFICATION_TOKEN_DERIVATION_SECRET
  // 設定時は、同一Notification Outbox Event(送信失敗→retry)のToken発行が同じ値を返し続け、
  // 先に配送されたメールのURLを後続retryが無効化しない。
  describe('NOTIFICATION_TOKEN_DERIVATION_SECRET設定時', () => {
    const originalSecret = process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET;

    beforeEach(() => {
      process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET = 'c'.repeat(32);
    });

    afterEach(() => {
      if (originalSecret === undefined) delete process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET;
      else process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET = originalSecret;
    });

    it('送信失敗後のretryでも同一Tokenを再利用する(URLが無効化されない)', async () => {
      await setSetting('wallet_claim_web_base_url', 'https://wallet.example.com');
      const { order, claim } = await createOrderWithClaim('deterministic-resendfail');
      await repo.enqueueNotification(prisma, {
        eventType: 'wallet_claim_reissued',
        recipient: order.customerEmail,
        payload: { orderId: order.id },
      });

      sendViaResendOrThrow.mockImplementationOnce(async () => {
        throw new Error('resend 5xx');
      });
      await dispatchPendingNotifications();
      const afterFirstFailure = await prisma.walletClaim.findUniqueOrThrow({ where: { id: claim.id } });
      expect(afterFirstFailure.reissueCount).toBe(1);

      await prisma.notificationOutboxEvent.updateMany({
        where: { recipient: order.customerEmail },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });

      const secondResult = await dispatchPendingNotifications();
      expect(secondResult.succeeded).toBe(1);
      const afterSecondSuccess = await prisma.walletClaim.findUniqueOrThrow({ where: { id: claim.id } });
      // 決定論的発行のため、retryでもTokenをrotateしない(reissueCountは1のまま)。
      expect(afterSecondSuccess.reissueCount).toBe(1);
      expect(afterSecondSuccess.tokenHash).toBe(afterFirstFailure.tokenHash);
    });
  });
});

describe('claimBatch(残課題指示書Stage3)', () => {
  const emailSuffix = `claim-batch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  afterEach(async () => {
    await prisma.notificationOutboxEvent.deleteMany({ where: { recipient: { contains: emailSuffix } } });
  });

  it('claim後のattemptCountはDBの更新後の値(increment済み)を反映する', async () => {
    const event = await repo.enqueueNotification(prisma, {
      eventType: 'agency_access_granted',
      recipient: `${emailSuffix}@example.com`,
      payload: { name: 'test' },
    });
    expect(event.attemptCount).toBe(0);

    const [claimed] = await repo.claimBatch(prisma, 10);
    expect(claimed.id).toBe(event.id);
    expect(claimed.attemptCount).toBe(1);

    const persisted = await prisma.notificationOutboxEvent.findUnique({ where: { id: event.id } });
    expect(persisted?.attemptCount).toBe(1);
  });

  it('Vercel Serverlessでの処理中断(取りこぼし)を想定: 一定時間放置されたprocessing行はpendingへ戻る', async () => {
    const event = await repo.enqueueNotification(prisma, {
      eventType: 'agency_access_granted',
      recipient: `${emailSuffix}-stale@example.com`,
      payload: { name: 'test' },
    });
    await prisma.notificationOutboxEvent.update({
      where: { id: event.id },
      data: { status: 'processing', processingToken: 'stale-token', processingStartedAt: new Date(Date.now() - 20 * 60 * 1000) },
    });

    const reclaimed = await repo.reclaimStaleProcessing(prisma);
    expect(reclaimed).toBeGreaterThanOrEqual(1);

    const updated = await prisma.notificationOutboxEvent.findUnique({ where: { id: event.id } });
    expect(updated?.status).toBe('pending');
    expect(updated?.processingToken).toBeNull();
  });
});
