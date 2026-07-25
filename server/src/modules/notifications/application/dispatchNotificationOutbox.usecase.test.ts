import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
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

    sendViaResendOrThrow.mockImplementationOnce(async () => {
      throw new Error('resend api error');
    });

    const result = await dispatchPendingNotifications();
    expect(result.claimed).toBe(1);
    expect(result.retrying).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.dead).toBe(0);

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

    sendViaResendOrThrow.mockImplementation(async () => {
      throw new Error('resend api error');
    });

    const result = await dispatchPendingNotifications();
    expect(result.dead).toBe(1);

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
