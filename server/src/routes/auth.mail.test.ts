import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const sendNotificationOrThrowMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../modules/notifications/application/sendNotification.usecase', () => ({
  sendNotification: async (..._args: unknown[]) => {},
  sendNotificationOrThrow: (...args: unknown[]) => sendNotificationOrThrowMock(...args),
}));

const app = createApp();
const ORIGIN = 'http://localhost:5173';

// Wallet Claim本番前安定化指示書(2026-07-25)Phase11: password_resetもOutboxを経由するが、
// この操作(会員自身のパスワード再設定申請)は管理者操作と同様、応答内で即時ディスパッチまで完了する。
describe('パスワードリセット申請のメール送信連携(通知Outbox化・本番前安定化指示書Phase11)', () => {
  afterEach(() => {
    sendNotificationOrThrowMock.mockClear();
  });

  afterAll(async () => {
    await prisma.notificationOutboxEvent.deleteMany({ where: { recipient: { contains: 'auth-mail-test' } } });
    await prisma.passwordResetToken.deleteMany({ where: { user: { email: { contains: 'auth-mail-test' } } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'auth-mail-test' } } });
    await prisma.$disconnect();
  });

  it('存在するメールアドレスの場合のみ通知予定が作成され、実送信まで完了する', async () => {
    const email = `auth-mail-test-${Date.now()}@example.com`;
    await request(app).post('/api/auth/register').set('Origin', ORIGIN).send({ name: 'テスト', email, password: 'password123' });

    await request(app).post('/api/auth/password-reset/request').set('Origin', ORIGIN).send({ email });

    const events = await prisma.notificationOutboxEvent.findMany({ where: { recipient: email, eventType: 'password_reset' } });
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('succeeded');
    expect(sendNotificationOrThrowMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationOrThrowMock).toHaveBeenCalledWith(expect.objectContaining({ to: email }), expect.any(String));

    sendNotificationOrThrowMock.mockClear();
    const nonexistentEmail = `nonexistent-auth-mail-test-${Date.now()}@example.com`;
    await request(app).post('/api/auth/password-reset/request').set('Origin', ORIGIN).send({ email: nonexistentEmail });
    expect(sendNotificationOrThrowMock).not.toHaveBeenCalled();
    const noEvents = await prisma.notificationOutboxEvent.findMany({ where: { recipient: nonexistentEmail } });
    expect(noEvents).toHaveLength(0);
  });
});
