import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const sendPasswordResetEmail = vi.fn(async (..._args: unknown[]) => {});

vi.mock('../services/mailTemplates', () => ({
  sendPasswordResetEmail: (...args: unknown[]) => sendPasswordResetEmail(...args),
  sendPurchaseCompleteEmail: vi.fn(async () => {}),
  sendGuestPasswordSetupEmail: vi.fn(async () => {}),
}));

const app = createApp();
const ORIGIN = 'http://localhost:5173';

describe('パスワードリセット申請のメール送信連携', () => {
  afterAll(async () => {
    await prisma.passwordResetToken.deleteMany({ where: { user: { email: { contains: 'auth-mail-test' } } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'auth-mail-test' } } });
    await prisma.$disconnect();
  });

  it('存在するメールアドレスの場合のみメール送信が呼ばれる', async () => {
    const email = `auth-mail-test-${Date.now()}@example.com`;
    await request(app).post('/api/auth/register').set('Origin', ORIGIN).send({ name: 'テスト', email, password: 'password123' });

    sendPasswordResetEmail.mockClear();
    await request(app).post('/api/auth/password-reset/request').set('Origin', ORIGIN).send({ email });
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(sendPasswordResetEmail).toHaveBeenCalledWith(email, 'テスト', expect.any(String));

    sendPasswordResetEmail.mockClear();
    await request(app)
      .post('/api/auth/password-reset/request')
      .set('Origin', ORIGIN)
      .send({ email: `nonexistent-auth-mail-test-${Date.now()}@example.com` });
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});
